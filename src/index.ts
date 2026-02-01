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

interface TargetDef {
  lastPosition: number
  msgCount: number
}

/**
 * @property confirmAfterMsgs Number of messages to receive before status is set to "confirmed"
 * @property confirmMaxAge Maximum interval (msec) between received messages before status is set to "stale"
 * @property lostAfter Maximum interval (msec) between received messages before status is set to "lost"
 * @property removeAfter Maximum interval (msec) between received messages before status is set to "remove"
 * @property interpHz Minimum interval (msec) to elapse between received messages for msgCount to be incremented
 */
interface ClassDefault {
  confirmAfterMsgs: number
  confirmMaxAge: number // msecs
  lostAfter: number // msecs
  removeAfter: number // msecs
  interpHz: number // msecs
}

enum AIS_STATUS {
  unconfirmed = 'unconfirmed',
  confirmed = 'confirmed',
  stale = 'stale',
  lost = 'lost',
  remove = 'remove'
}

const AIS_CLASS_DEFAULTS: Record<string, ClassDefault> = {
  A: {
    confirmAfterMsgs: 2,
    confirmMaxAge: 3 * 60000, // 3 min when moored, < 10 sec when moving)
    lostAfter: 6 * 60000,
    removeAfter: 9 * 60000,
    interpHz: 1000
  },
  B: {
    confirmAfterMsgs: 3,
    confirmMaxAge: 3 * 60000, // 3 min when moored, < 30 sec when moving)
    lostAfter: 6 * 60000,
    removeAfter: 9 * 60000,
    interpHz: 500
  },
  ATON: {
    confirmAfterMsgs: 1,
    confirmMaxAge: 3 * 60000, // 3 min nominal
    lostAfter: 15 * 60000, // 15 min = timeout / loss
    removeAfter: 60 * 60000,
    interpHz: 0
  },
  BASE: {
    confirmAfterMsgs: 1,
    confirmMaxAge: 10000, // 10 sec nominal
    lostAfter: 30000,
    removeAfter: 3 * 60000,
    interpHz: 0
  },
  SAR: {
    confirmAfterMsgs: 1,
    confirmMaxAge: 10000, // 10 sec nominal
    lostAfter: 30000,
    removeAfter: 3 * 60000,
    interpHz: 2000
  }
}

const STATUS_CHECK_INTERVAL = 5000

const CONFIG_SCHEMA = {
  properties: {}
}

const CONFIG_UISCHEMA = {}

module.exports = (server: SKAisApp): Plugin => {
  let subscriptions: any[] = [] // stream subscriptions
  let timers: Array<NodeJS.Timeout> = [] // interval timers

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

  let settings: any = {}
  let self: string = ''
  let targets: Map<Context, TargetDef> = new Map()

  const doStartup = (options: any) => {
    try {
      server.debug(`${plugin.name} starting.......`)
      if (options) {
        settings = options
      } else {
        // save defaults if no options loaded
        server.savePluginOptions(settings, () => {
          server.debug(`Default configuration applied...`)
        })
      }
      server.debug(`Applied configuration: ${JSON.stringify(settings)}`)
      server.setPluginStatus(`Started`)

      // initialise plugin
      initialise()
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
   * initialise plugin
   */
  const initialise = () => {
    server.debug('Initialising ....')
    // setup subscriptions
    initSubscriptions()
    self = server.getPath('self')
    timers.push(setInterval(() => checkStatus(), STATUS_CHECK_INTERVAL))
  }

  // register DELTA stream message handler
  const initSubscriptions = () => {
    server.debug('Initialising Stream Subscriptions....')
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
      console.log('self:', self)
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

  /**
   * Check and update AIS target(s) status
   */
  const checkStatus = () => {
    const rmIds: Context[] = []
    targets.forEach((v: TargetDef, k: Context) => {
      const aisClass = getAisClass(k)
      const tDiff = Date.now() - v.lastPosition
      if (tDiff >= AIS_CLASS_DEFAULTS[aisClass].removeAfter) {
        rmIds.push(k)
        v.msgCount = 0
        emitAisStatus(k, AIS_STATUS.remove)
      } else if (tDiff >= AIS_CLASS_DEFAULTS[aisClass].lostAfter) {
        rmIds.push(k)
        v.msgCount = 0
        emitAisStatus(k, AIS_STATUS.lost)
      } else if (tDiff >= AIS_CLASS_DEFAULTS[aisClass].confirmMaxAge) {
        rmIds.push(k)
        emitAisStatus(k, AIS_STATUS.stale)
      }
    })
  }

  /** Process target after position message */
  const processTarget = (context: Context) => {
    const target: TargetDef = targets.get(context) as TargetDef
    if (!target) return

    const aisClass = getAisClass(context)

    const tDiff = Date.now() - target?.lastPosition
    // interpHz threshold met?
    if (tDiff < AIS_CLASS_DEFAULTS[aisClass].interpHz) return

    target.lastPosition = Date.now()
    target.msgCount++

    // confirmMsg threshold met?
    if (target.msgCount < AIS_CLASS_DEFAULTS[aisClass].confirmAfterMsgs) {
      //server.debug('*** unconfirmed', target.msgCount, context, aisClass)
      target.msgCount++
      emitAisStatus(context, AIS_STATUS.unconfirmed)
    } else {
      //server.debug('*** confirmed', target.msgCount, context, aisClass)
      emitAisStatus(context, AIS_STATUS.confirmed)
    }
    targets.set(context, target)
  }

  /**
   * Return AIS Class of supplied Context
   * @param context Signal K context
   * @returns AIS class (defaults to 'A' if missing or invalid)
   */
  const getAisClass = (context: Context): string => {
    let p = server.getPath(`${context}.sensors.ais.class`)
    let c = p?.value ?? 'A'
    return Object.keys(AIS_CLASS_DEFAULTS).includes(c) ? c : 'A'
  }

  /**
   * Emits sensors.ais.status delta
   * @param context Signal K context
   */
  const emitAisStatus = (context: Context, status: AIS_STATUS) => {
    let currStatus = server.getPath(`${context}.sensors.ais.status`)
    if (status !== currStatus?.value) {
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
    }
  }

  return plugin
}
