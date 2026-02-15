// **** Signal K flags resources ****
import {
  Context,
  Delta,
  Path,
  PathValue,
  Plugin,
  SKVersion,
  ServerAPI,
  SubscribeMessage,
  Update,
  hasValues
} from '@signalk/server-api'

interface SKAisApp extends ServerAPI {}

/**
 * In-memory tracking data for a target context.
 * @property lastPosition Timestamp (ms) of last received position
 * @property msgCount Number of recent position messages counted toward confirmation
 */
interface TargetDef {
  lastPosition: number
  msgCount: number
}

/**
 * @property confirmAfterMsgs Number of messages to receive before status is set to "confirmed".
 * @property confirmMaxAge Maximum gap (msec) between received messages while unconfirmed before confirmation process is reset.
 * @property lostAfter Maximum interval (msec) between received messages before status is set to "lost".
 * @property removeAfter Maximum interval (msec) between received messages before status is set to "remove".
 */
interface ClassDefault {
  confirmAfterMsgs: number
  confirmMaxAge: number // msecs
  lostAfter: number // msecs
  removeAfter: number // msecs
}

enum AIS_STATUS {
  unconfirmed = 'unconfirmed',
  confirmed = 'confirmed',
  lost = 'lost',
  remove = 'remove'
}

type AISClass = 'A' | 'B' | 'ATON' | 'BASE' | 'SAR' | 'AIRCRAFT'

const AIS_CLASS_DEFAULTS: Record<AISClass, ClassDefault> = {
  A: {
    confirmAfterMsgs: 2,
    confirmMaxAge: 3 * 60000, // 3 min when moored, < 10 sec when moving)
    lostAfter: 6 * 60000,
    removeAfter: 9 * 60000
  },
  B: {
    confirmAfterMsgs: 3,
    confirmMaxAge: 3 * 60000, // 3 min when moored, < 30 sec when moving)
    lostAfter: 6 * 60000,
    removeAfter: 9 * 60000
  },
  ATON: {
    confirmAfterMsgs: 1,
    confirmMaxAge: 3 * 60000, // 3 min nominal
    lostAfter: 15 * 60000, // 15 min = timeout / loss
    removeAfter: 60 * 60000
  },
  BASE: {
    confirmAfterMsgs: 1,
    confirmMaxAge: 10000, // 10 sec nominal
    lostAfter: 30000,
    removeAfter: 3 * 60000
  },
  SAR: {
    confirmAfterMsgs: 1,
    confirmMaxAge: 10000, // 10 sec nominal
    lostAfter: 30000,
    removeAfter: 3 * 60000
  },
  AIRCRAFT: {
    confirmAfterMsgs: 1,
    confirmMaxAge: 10000, // treat similarly to SAR/BASE (fast turnover)
    lostAfter: 30000,
    removeAfter: 3 * 60000
  }
}

const isAISClass = (value: unknown): value is AISClass =>
  typeof value === 'string' &&
  ['A', 'B', 'ATON', 'BASE', 'SAR', 'AIRCRAFT'].includes(value)

const classFromContext = (context: Context): AISClass => {
  if (context.startsWith('atons.')) return 'ATON'
  if (context.startsWith('shore.basestations.')) return 'BASE'
  if (context.startsWith('sar.')) return 'SAR'
  if (context.startsWith('aircraft.')) return 'AIRCRAFT'
  return 'B'
}

const STATUS_CHECK_INTERVAL = 5000

const CONFIG_SCHEMA = {
  properties: {
    confirmMaxAgeRatio: {
      type: 'number',
      title: 'Confirmation max age margin',
      description:
        'Multiplier applied to the maximum message age threshold of the target confirmation process (e.g., 1.1 = +10%). Applied to all AIS classes.',
      default: 1.1,
      minimum: 0.1
    }
  }
}

const CONFIG_UISCHEMA = {}

const DEFAULT_SETTINGS = {
  confirmMaxAgeRatio: 1.1
}

module.exports = (server: SKAisApp): Plugin => {
  let subscriptions: any[] = [] // stream subscriptions
  let timers: Array<NodeJS.Timeout> = [] // interval timers

  const getStringPath = (path: string): string | undefined => {
    const result = server.getPath(path)
    return typeof result === 'string' ? result : undefined
  }

  const getPathValue = <T>(path: string): T | undefined => {
    const result = server.getPath(path)
    if (result && typeof result === 'object' && 'value' in result) {
      return (result as { value: T }).value
    }
    return undefined
  }

  const plugin: Plugin = {
    id: 'sk-ais-status',
    name: 'AIS Status Manager',
    schema: () => CONFIG_SCHEMA,
    uiSchema: () => CONFIG_UISCHEMA,
    start: (options: any, restart: any) => {
      doStartup(options)
    },
    stop: () => {
      doShutdown()
    }
  }

  let settings: any = { ...DEFAULT_SETTINGS }
  let self: string = ''
  let targets: Map<Context, TargetDef> = new Map()

  const doStartup = (options: any) => {
    try {
      server.debug(`${plugin.name} starting.......`)
      if (options) {
        settings = { ...DEFAULT_SETTINGS, ...options }
      } else {
        // save defaults if no options loaded
        server.savePluginOptions(settings, () => {
          server.debug(`Default configuration applied...`)
        })
      }
      server.debug(`Applied configuration: ${JSON.stringify(settings)}`)
      server.setPluginStatus(`Started`)

      // initialize plugin
      initialize()
    } catch (error) {
      const msg = `Started with errors!`
      server.setPluginError(msg)
      server.error('error: ' + error)
    }
  }

  const doShutdown = () => {
    server.debug(`${plugin.name} stopping.......`)
    server.debug('** Un-registering Update Handler(s) **')
    subscriptions.forEach((b) => b())
    subscriptions = []
    server.debug('** Stopping Timer(s) **')
    timers.forEach((t) => clearInterval(t))
    timers = []
    const msg = 'Stopped.'
    server.setPluginStatus(msg)
  }

  /**
   * initialize plugin
   */
  const initialize = () => {
    server.debug('Initializing ....')
    // setup subscriptions
    initSubscriptions()
    self = getStringPath('self') ?? ''
    timers.push(setInterval(() => checkStatus(), STATUS_CHECK_INTERVAL))
  }

  // register DELTA stream message handler
  const initSubscriptions = () => {
    const subDef = [
      {
        path: 'navigation.position' as Path,
        period: 500
      }
    ]
    const subs: SubscribeMessage[] = [
      {
        context: 'vessels.*' as Context,
        subscribe: subDef
      },
      {
        context: 'atons.*' as Context,
        subscribe: subDef
      },
      {
        context: 'shore.basestations.*' as Context,
        subscribe: subDef
      },
      {
        context: 'sar.*' as Context,
        subscribe: subDef
      },
      {
        context: 'aircraft.*' as Context,
        subscribe: subDef
      }
    ]
    server.debug(
      `Subscribing to contexts: ${subs.map((s) => s.context).join(', ')}`
    )
    server.debug(
      `With paths: ${subDef
        .map((s) => `${s.path} (${s.period} ms)`)
        .join(', ')}`
    )
    subs.forEach((s) => {
      server.subscriptionmanager.subscribe(s, subscriptions, onError, onMessage)
    })
  }

  /**
   * Delta message handler
   * @param delta Delta message
   */
  const onMessage = (delta: Delta) => {
    if (!delta.updates) {
      return
    }

    if (delta.context === self) {
      return
    }
    delta.updates.forEach((u: Update) => {
      if (!hasValues(u)) {
        return
      }
      u.values.forEach((v: PathValue) => {
        if (v.path === 'navigation.position') {
          if (!targets.has(delta.context as Context)) {
            targets.set(delta.context as Context, {
              lastPosition: 0,
              msgCount: 0
            })
          }
          processTarget(delta.context as Context)
        }
      })
    })
  }

  /** Handle subscription error */
  const onError = (error: unknown) => {
    server.error(`${plugin.id} Error: ${error}`)
  }

  /** Process target after position message */
  const processTarget = (context: Context) => {
    const target: TargetDef = targets.get(context) as TargetDef
    if (!target) return

    const aisClass = getAisClass(context)
    const confirmMaxAge = getConfirmMaxAge(aisClass)
    const now = Date.now()

    if (
      target.msgCount > 0 &&
      target.msgCount < AIS_CLASS_DEFAULTS[aisClass].confirmAfterMsgs
    ) {
      const elapse = now - target.lastPosition
      if (elapse > confirmMaxAge) {
        server.debug(
          `*** Confirm max age exceeded (${elapse} ms > ${confirmMaxAge} ms) -> reset confirmation`,
          context,
          aisClass
        )
        target.msgCount = 0
      }
    }

    const msgNo = target.msgCount + 1
    target.lastPosition = now

    // confirmMsg threshold met?
    if (msgNo < AIS_CLASS_DEFAULTS[aisClass].confirmAfterMsgs) {
      target.msgCount = msgNo
      if (emitAisStatus(context, AIS_STATUS.unconfirmed)) {
        server.debug(
          `*** Threshold not met (${msgNo}/${AIS_CLASS_DEFAULTS[aisClass].confirmAfterMsgs}) -> unconfirmed`,
          context,
          aisClass
        )
      }
    } else {
      target.msgCount = AIS_CLASS_DEFAULTS[aisClass].confirmAfterMsgs
      if (emitAisStatus(context, AIS_STATUS.confirmed)) {
        server.debug(
          `*** Threshold met (${msgNo}/${AIS_CLASS_DEFAULTS[aisClass].confirmAfterMsgs}) -> confirmed`,
          context,
          aisClass
        )
      }
    }
    targets.set(context, target)
  }

  /**
   * Return AIS Class of supplied Context
   * @param context Signal K context
   * @returns AIS class (falls back to context-derived class)
   */
  const getAisClass = (context: Context): AISClass => {
    const aisClass = getPathValue<unknown>(`${context}.sensors.ais.class`)
    if (isAISClass(aisClass)) {
      return aisClass
    }
    return classFromContext(context)
  }

  const getConfirmMaxAge = (aisClass: AISClass): number => {
    const ratio = Number(settings.confirmMaxAgeRatio)
    if (!Number.isFinite(ratio) || ratio <= 0) {
      return AIS_CLASS_DEFAULTS[aisClass].confirmMaxAge
    }
    return Math.round(AIS_CLASS_DEFAULTS[aisClass].confirmMaxAge * ratio)
  }

  /**
   * Check and update AIS target(s) status
   */
  const checkStatus = () => {
    targets.forEach((v: TargetDef, k: Context) => {
      const aisClass = getAisClass(k)
      const tDiff = Date.now() - v.lastPosition
      if (tDiff >= AIS_CLASS_DEFAULTS[aisClass].removeAfter) {
        if (emitAisStatus(k, AIS_STATUS.remove)) {
          server.debug('*** Remove threshold met -> remove', k, aisClass)
        }
        targets.delete(k)
      } else if (tDiff >= AIS_CLASS_DEFAULTS[aisClass].lostAfter) {
        v.msgCount = 0
        if (emitAisStatus(k, AIS_STATUS.lost)) {
          server.debug('*** Lost threshold met -> lost', k, aisClass)
        }
      }
    })
  }

  /**
   * Emits sensors.ais.status delta
   * @param context Signal K context
   */
  const emitAisStatus = (context: Context, status: AIS_STATUS): boolean => {
    const currStatus = getPathValue<AIS_STATUS>(`${context}.sensors.ais.status`)
    if (status === currStatus) {
      return false
    }
    server.handleMessage(
      plugin.id,
      {
        context: context,
        updates: [
          {
            values: [
              {
                path: 'sensors.ais.status' as Path,
                value: status
              }
            ]
          }
        ]
      },
      SKVersion.v1
    )
    return true
  }

  return plugin
}
