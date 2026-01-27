// **** Signal K flags resources ****
import {
  Context,
  Delta,
  Path,
  PathValue,
  Plugin,
  ServerAPI,
  SubscribeMessage,
  Update,
  hasValues
} from '@signalk/server-api'


export interface SKAisApp extends ServerAPI {}

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
  }

  // register DELTA stream message handler
  const initSubscriptions = () => {
    server.debug('Initialising Stream Subscription....')

    const subscription: SubscribeMessage = {
      context: 'vessels.*' as Context,
      subscribe: [
        {
          path: '' as Path,
          period: 500
        }
      ]
    }

    server.subscriptionmanager.subscribe(
      subscription,
      subscriptions,
      (error) => {
        server.error(`${plugin.id} Error: ${error}`)
      },
      (delta: Delta) => {
        if (!delta.updates) {
          return
        }
        const context = delta.context
        delta.updates.forEach((u: Update) => {
          if (!hasValues(u)) {
            return
          }
          u.values.forEach((v: PathValue) => {
            if (v.path === '' && v.value && 'mmsi' in (v.value as object)) {
              // if doesn't already have xxx property
              const vf = server.getPath(`${context}.xxx`)
              if (!vf) {
                server.handleMessage(plugin.id, {
                  context: context,
                  updates: [
                    {
                      values: [
                        {
                          path: 'xxx' as Path,
                          value: 'new value'
                        }
                      ]
                    }
                  ]
                })
                
              }
            }
          })
        })
      }
    )
  }

  return plugin
}
