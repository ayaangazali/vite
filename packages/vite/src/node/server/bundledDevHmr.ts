import path from 'node:path'
import type { ModuleInfo, PartialResolvedId } from 'rolldown'
import { FS_PREFIX } from '../constants'
import { monotonicDateNow, removeTimestampQuery } from '../utils'
import { cleanUrl, withTrailingSlash, wrapId } from '../../shared/utils'
import { getHookHandler } from '../plugins'
import type { Plugin } from '../plugin'
import {
  ignoreDeprecationWarnings,
  warnFutureDeprecation,
} from '../deprecations'
import type { ViteDevServer } from '..'
import { EnvironmentModuleGraph, EnvironmentModuleNode } from './moduleGraph'
import {
  type HmrContext,
  type HotUpdateOptions,
  debugHmr,
  readModifiedFile,
} from './hmr'
import {
  BasicMinimalPluginContext,
  basePluginContextMeta,
} from './pluginContainer'
import type { ModuleNode } from './mixedModuleGraph'
import type { DevEnvironment } from './environment'
import type { BundledDev } from './bundledDev'

/**
 * The arguments rolldown's dev-only `hotUpdate` plugin hook receives.
 * Declared structurally so this file does not depend on rolldown's
 * experimental export surface.
 */
interface RolldownHotUpdateArgs {
  type: 'create' | 'update' | 'delete'
  file: string
  /** Raw module ids of the currently-affected set. */
  modules: string[]
  read: () => Promise<string>
}

/** The subset of rolldown's plugin context the facade reads. */
interface RolldownHotUpdateContext {
  getModuleInfo: (id: string) => ModuleInfo | null
  getModuleIds: () => IterableIterator<string>
}

type RolldownHotUpdateHandler = (
  this: RolldownHotUpdateContext,
  options: RolldownHotUpdateArgs,
) => Promise<string[] | undefined>

/**
 * Module graph facade for bundled dev. The rolldown dev engine owns the real
 * graph; this class materializes `EnvironmentModuleNode`s on demand from the
 * engine's module registry (`getModuleInfo`) so `hotUpdate` /
 * `handleHotUpdate` hooks and `server.moduleGraph` consumers keep working.
 *
 * Every node for a given id is created exactly once and cached in the
 * inherited `idToModuleMap` — plugins compare nodes by reference and stash
 * state on them, so identity is part of the contract. A node's `info`,
 * `importers` and `importedModules` are lazy views over the engine registry,
 * so they stay current across rebuilds without invalidation bookkeeping.
 */
export class BundledModuleGraph extends EnvironmentModuleGraph {
  /** @internal */
  _root: string
  /** @internal */
  _getModuleInfo: ((id: string) => ModuleInfo | null) | undefined
  /** @internal */
  _getModuleIds: (() => IterableIterator<string>) | undefined
  /** @internal set by the hot-update adapter */
  _onInvalidateModule: ((mod: EnvironmentModuleNode) => void) | undefined
  /** @internal set by the hot-update adapter */
  _onInvalidateAll: (() => void) | undefined

  constructor(
    environment: string,
    root: string,
    resolveId: (url: string) => Promise<PartialResolvedId | null>,
  ) {
    super(environment, resolveId)
    this._root = root
  }

  /**
   * @internal
   * Rebind to the plugin context of the current build. Contexts are
   * per-build, so this is refreshed from `buildStart` and from every
   * hot-update event.
   */
  _updateContext(ctx: RolldownHotUpdateContext): void {
    this._getModuleInfo = (id) => ctx.getModuleInfo(id)
    this._getModuleIds = () => ctx.getModuleIds()
  }

  /** Get or create the facade node for a raw module id. */
  ensureBundledNode(id: string): EnvironmentModuleNode {
    const existing = this.idToModuleMap.get(id)
    if (existing) {
      return existing
    }
    const mod = new EnvironmentModuleNode(this._urlForId(id), this.environment)
    mod.id = id
    mod.file = cleanUrl(id)
    // The base class declares these as data properties; replace them with
    // always-current views over the engine registry. Writes are dropped —
    // mutating graph nodes is a documented no-op under bundled dev.
    const lazy = (prop: string, get: () => unknown) =>
      Object.defineProperty(mod, prop, {
        configurable: true,
        enumerable: true,
        get,
        set: () => {},
      })
    lazy('info', () => this._getModuleInfo?.(id) ?? undefined)
    lazy('importers', () =>
      this._nodeSet(this._getModuleInfo?.(id)?.importers),
    )
    lazy('importedModules', () =>
      this._nodeSet(this._getModuleInfo?.(id)?.importedIds),
    )
    this.idToModuleMap.set(id, mod)
    if (!this.urlToModuleMap.has(mod.url)) {
      this.urlToModuleMap.set(mod.url, mod)
    }
    let fileMappedModules = this.fileToModulesMap.get(mod.file)
    if (!fileMappedModules) {
      fileMappedModules = new Set()
      this.fileToModulesMap.set(mod.file, fileMappedModules)
    }
    fileMappedModules.add(mod)
    return mod
  }

  override getModuleById(id: string): EnvironmentModuleNode | undefined {
    const mod = super.getModuleById(id)
    if (mod) {
      return mod
    }
    const cleanId = removeTimestampQuery(id)
    if (this._getModuleInfo?.(cleanId)) {
      return this.ensureBundledNode(cleanId)
    }
    return undefined
  }

  override getModulesByFile(
    file: string,
  ): Set<EnvironmentModuleNode> | undefined {
    if (this._getModuleIds) {
      for (const id of this._getModuleIds()) {
        if (!this.idToModuleMap.has(id) && cleanUrl(id) === file) {
          this.ensureBundledNode(id)
        }
      }
    }
    return super.getModulesByFile(file)
  }

  /**
   * Inside a hot-update event this buffers the module into the event's
   * affected set (merged by the adapter's finalize hook). Outside an event it
   * is a no-op — the engine owns invalidation under bundled dev.
   */
  override invalidateModule(mod: EnvironmentModuleNode): void {
    this._onInvalidateModule?.(mod)
  }

  /** Maps to a full rebuild plus a page reload under bundled dev. */
  override invalidateAll(): void {
    this._onInvalidateAll?.()
  }

  private _nodeSet(
    ids: readonly string[] | undefined,
  ): Set<EnvironmentModuleNode> {
    const nodes = new Set<EnvironmentModuleNode>()
    for (const id of ids ?? []) {
      nodes.add(this.ensureBundledNode(id))
    }
    return nodes
  }

  private _urlForId(id: string): string {
    if (id.startsWith('\0') || id.startsWith('virtual:')) {
      return wrapId(id)
    }
    if (id.startsWith(withTrailingSlash(this._root))) {
      return id.slice(this._root.length)
    }
    if (path.isAbsolute(id)) {
      return path.posix.join(FS_PREFIX, id)
    }
    return id
  }
}

interface HotUpdateEventState {
  timestamp: number
  /** Ids buffered from in-hook `moduleGraph.invalidateModule(...)` calls. */
  invalidatedIds: Set<string>
  /** The one `HmrContext` shared by every legacy wrapper for this file event. */
  mixedCtx?: HmrContext
}

/**
 * Runs Vite's `hotUpdate` / `handleHotUpdate` plugin contracts on top of
 * rolldown's dev-only `hotUpdate` hook.
 *
 * Each Vite plugin with either hook gets a per-plugin wrapper assigned as its
 * rolldown `hotUpdate` hook (preserving `order` meta), so rolldown's driver
 * reproduces Vite's plugin ordering and the replace-chain semantics
 * (returned array replaces the affected set, empty array suppresses). A
 * pre-ordered init hook opens the per-file event state and a post-ordered
 * finalize hook merges buffered invalidations and closes it.
 */
export class BundledDevHotUpdateAdapter {
  private server: ViteDevServer | undefined
  private states = new Map<string, HotUpdateEventState>()
  private activeFile: string | undefined
  private legacyContext: BasicMinimalPluginContext

  constructor(
    private environment: DevEnvironment,
    private graph: BundledModuleGraph,
    private bundledDev: BundledDev,
  ) {
    this.legacyContext = new BasicMinimalPluginContext(
      { ...basePluginContextMeta, watchMode: true },
      environment.getTopLevelConfig().logger,
    )
    graph._onInvalidateModule = (mod) => {
      const state = this.activeFile
        ? this.states.get(this.activeFile)
        : undefined
      if (state && mod.id) {
        state.invalidatedIds.add(mod.id)
      } else {
        debugHmr?.(
          `invalidateModule(${mod.id}) outside a hot-update event is a no-op under bundled dev`,
        )
      }
    }
    graph._onInvalidateAll = () => {
      this.bundledDev.requestFullBuildReload()
    }
  }

  setServer(server: ViteDevServer): void {
    this.server = server
  }

  /**
   * Wrap every plugin-level `hotUpdate` / `handleHotUpdate` (a plugin with
   * both uses `hotUpdate`, matching Vite) and bracket the chain with the
   * init/finalize hooks. Mutates `plugins` in place. When no plugin has
   * either hook, only the context-capture plugin is added (it has no
   * `hotUpdate` hook, so the engine skips the hook path entirely).
   */
  wrapPlugins(plugins: unknown[]): void {
    // Only wrap top-level vite plugins. A plugin swapped in per environment
    // via `applyToEnvironment` (e.g. `vite:import-glob`) is a rolldown
    // plugin: its `hotUpdate` already expects rolldown ids and must stay
    // unwrapped. `plugins[i]` is a clone of `environment.plugins[i]` (made
    // by `injectEnvironmentToHooks`), so the original is looked up by index,
    // with a name check to catch misalignment.
    const environmentPlugins = this.environment.plugins
    const topLevelPlugins = new Set(
      this.environment.getTopLevelConfig().plugins,
    )
    let wrapped = 0
    for (let i = 0; i < plugins.length; i++) {
      const plugin = plugins[i] as Plugin
      if (!plugin || typeof plugin !== 'object') continue
      const source = environmentPlugins[i]
      if (
        !source ||
        source.name !== plugin.name ||
        !topLevelPlugins.has(source)
      ) {
        continue
      }
      if (plugin.hotUpdate) {
        ;(plugin as any).hotUpdate = this._wrapHotUpdate(plugin)
        wrapped++
      } else if (plugin.handleHotUpdate) {
        ;(plugin as any).hotUpdate = this._wrapHandleHotUpdate(plugin)
        wrapped++
      }
    }

    const adapter = this
    const pre: any = {
      name: 'vite:bundled-dev-hot-update-pre',
      // captures a plugin context every build so the module graph facade can
      // serve reads outside hot-update events too
      buildStart(this: RolldownHotUpdateContext) {
        adapter.graph._updateContext(this)
      },
    }
    if (wrapped > 0) {
      pre.hotUpdate = {
        order: 'pre',
        handler(
          this: RolldownHotUpdateContext,
          options: RolldownHotUpdateArgs,
        ) {
          adapter.graph._updateContext(this)
          adapter.activeFile = options.file
          adapter.states.set(options.file, {
            timestamp: monotonicDateNow(),
            invalidatedIds: new Set(),
          })
        },
      }
    }
    plugins.unshift(pre)
    if (wrapped > 0) {
      plugins.push({
        name: 'vite:bundled-dev-hot-update-post',
        hotUpdate: {
          order: 'post',
          handler(options: RolldownHotUpdateArgs) {
            const state = adapter.states.get(options.file)
            adapter.states.delete(options.file)
            if (adapter.activeFile === options.file) {
              adapter.activeFile = undefined
            }
            if (state && state.invalidatedIds.size > 0) {
              const merged = new Set(options.modules)
              for (const id of state.invalidatedIds) {
                merged.add(id)
              }
              return [...merged]
            }
          },
        },
      })
    }
  }

  private _wrapHotUpdate(plugin: Plugin): unknown {
    const hook = plugin.hotUpdate!
    const handler = getHookHandler(hook)
    const adapter = this
    const wrappedHandler: RolldownHotUpdateHandler = async function (options) {
      adapter.graph._updateContext(this)
      const state = adapter._ensureState(options.file)
      const viteOptions: HotUpdateOptions = {
        type: options.type,
        file: options.file,
        timestamp: state.timestamp,
        modules: options.modules.map((id) =>
          adapter.graph.ensureBundledNode(id),
        ),
        read: () => readModifiedFile(options.file),
        server: adapter._requireServer(),
      }
      const result = await handler.call(
        adapter.environment.pluginContainer.minimalContext as any,
        viteOptions,
      )
      if (result) {
        return result
          .map((mod: EnvironmentModuleNode) => mod.id)
          .filter((id: string | null): id is string => id != null)
      }
    }
    return typeof hook === 'object' && hook.order
      ? { order: hook.order, handler: wrappedHandler }
      : wrappedHandler
  }

  private _wrapHandleHotUpdate(plugin: Plugin): unknown {
    const hook = plugin.handleHotUpdate!
    const handler = getHookHandler(hook)
    const config = this.environment.getTopLevelConfig()
    const adapter = this
    const wrappedHandler: RolldownHotUpdateHandler = async function (options) {
      // vite parity: the legacy hook only ever fires for updates
      if (options.type !== 'update') {
        return
      }
      adapter.graph._updateContext(this)
      const state = adapter._ensureState(options.file)
      const server = adapter._requireServer()
      const mixedGraph = ignoreDeprecationWarnings(() => server.moduleGraph)
      const toMixed = (id: string) =>
        mixedGraph.getBackwardCompatibleModuleNode(
          adapter.graph.ensureBundledNode(id),
        )
      let ctx = state.mixedCtx
      if (!ctx) {
        ctx = state.mixedCtx = {
          file: options.file,
          timestamp: state.timestamp,
          modules: options.modules.map(toMixed),
          read: () => readModifiedFile(options.file),
          server,
        }
      } else {
        // an interleaved new-contract hook may have replaced the affected
        // set — reconcile while keeping this event's shared context object
        // (and its `read`, which legacy plugins reassign for downstream
        // plugins)
        const currentIds = new Set(options.modules)
        ctx.modules = ctx.modules.filter(
          (mod) => mod.id != null && currentIds.has(mod.id),
        )
        for (const id of options.modules) {
          if (!ctx.modules.some((mod) => mod.id === id)) {
            ctx.modules.push(toMixed(id))
          }
        }
      }
      warnFutureDeprecation(
        config,
        'removePluginHookHandleHotUpdate',
        `Used in plugin "${plugin.name}".`,
        false,
      )
      const result = await handler.call(adapter.legacyContext as any, ctx)
      if (result) {
        ctx.modules = result
        return result
          .map((mod: ModuleNode) => mod.id)
          .filter((id: string | null): id is string => id != null)
      }
    }
    return typeof hook === 'object' && hook.order
      ? { order: hook.order, handler: wrappedHandler }
      : wrappedHandler
  }

  private _ensureState(file: string): HotUpdateEventState {
    let state = this.states.get(file)
    if (!state) {
      state = { timestamp: monotonicDateNow(), invalidatedIds: new Set() }
      this.states.set(file, state)
    }
    this.activeFile = file
    return state
  }

  private _requireServer(): ViteDevServer {
    if (!this.server) {
      throw new Error(
        'a hotUpdate hook fired before the dev server was ready',
      )
    }
    return this.server
  }
}
