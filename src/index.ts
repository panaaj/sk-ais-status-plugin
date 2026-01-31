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

interface ClassDefault {
  confirmAfterMsgs: number
  confirmMaxAge: number // msecs
  lostAfter: number // msecs
  removeAfter: number // msecs
  interpHz: number // msecs
}

const AIS_CLASS_DEFAULTS: Record<string, ClassDefault> = {
  A: {
    confirmAfterMsgs: 2,
    confirmMaxAge: 30000,
    lostAfter: 60000,
    removeAfter: 180000,
    interpHz: 1000
  },
  B: {
    confirmAfterMsgs: 3,
    confirmMaxAge: 90000,
    lostAfter: 180000,
    removeAfter: 600000,
    interpHz: 500
  },
  ATON: {
    confirmAfterMsgs: 1,
    confirmMaxAge: 180000,
    lostAfter: 900000,
    removeAfter: 3600000,
    interpHz: 0
  },
  BASE: {
    confirmAfterMsgs: 1,
    confirmMaxAge: 120000,
    lostAfter: 600000,
    removeAfter: 1800000,
    interpHz: 0
  },
  SAR: {
    confirmAfterMsgs: 1,
    confirmMaxAge: 10000,
    lostAfter: 30000,
    removeAfter: 120000,
    interpHz: 2000
  }
}

const CONFIG_SCHEMA = {
  properties: {}
}

const CONFIG_UISCHEMA = {}

module.exports = (server: SKAisApp): Plugin => {
  let subscriptions: any[] = [] // stream subscriptions

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

  /** Process target after position message */
  const processTarget = (context: Context) => {
    const target: TargetDef = targets.get(context) as TargetDef
    if (!target) return

    let p = server.getPath(`${context}.sensors.ais.class`)
    // process class values and default to A if missing or invalid
    let aisClass = !p?.value ? 'A' : p.value
    aisClass = Object.keys(AIS_CLASS_DEFAULTS).includes(aisClass)
      ? aisClass
      : 'A'

    const tDiff = Date.now() - target?.lastPosition
    // interpHz threshold met?
    if (tDiff < AIS_CLASS_DEFAULTS[aisClass].interpHz) return

    target.lastPosition = Date.now()
    target.msgCount++

    // confirmMsg threshold met?
    if (target.msgCount >= AIS_CLASS_DEFAULTS[aisClass].confirmAfterMsgs) {
      //server.debug('*** confirmed', target.msgCount, context, aisClass)
      target.msgCount = 0
      server.handleMessage(
        plugin.id,
        {
          context: context,
          updates: [
            {
              values: [
                {
                  path: 'sensors.ais.status' as Path,
                  value: 'confirmed'
                }
              ]
            }
          ]
        },
        SKVersion.v1
      )
    }
    targets.set(context, target)
  }

  return plugin
}
