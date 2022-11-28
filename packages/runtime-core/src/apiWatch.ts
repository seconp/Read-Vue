import {
  effect,
  stop,
  isRef,
  Ref,
  ComputedRef,
  ReactiveEffectOptions,
  isReactive
} from '@vue/reactivity'
import { SchedulerJob, queuePreFlushCb } from './scheduler'
import {
  EMPTY_OBJ,
  isObject,
  isArray,
  isFunction,
  isString,
  hasChanged,
  NOOP,
  remove,
  isMap,
  isSet
} from '@vue/shared'
import {
  currentInstance,
  ComponentInternalInstance,
  isInSSRComponentSetup,
  recordInstanceBoundEffect
} from './component'
import {
  ErrorCodes,
  callWithErrorHandling,
  callWithAsyncErrorHandling
} from './errorHandling'
import { queuePostRenderEffect } from './renderer'
import { warn } from './warning'

export type WatchEffect = (onInvalidate: InvalidateCbRegistrator) => void

export type WatchSource<T = any> = Ref<T> | ComputedRef<T> | (() => T)

export type WatchCallback<V = any, OV = any> = (
  value: V,
  oldValue: OV,
  onInvalidate: InvalidateCbRegistrator
) => any

type MapSources<T> = {
  [K in keyof T]: T[K] extends WatchSource<infer V>
    ? V
    : T[K] extends object ? T[K] : never
}

type MapOldSources<T, Immediate> = {
  [K in keyof T]: T[K] extends WatchSource<infer V>
    ? Immediate extends true ? (V | undefined) : V
    : T[K] extends object
      ? Immediate extends true ? (T[K] | undefined) : T[K]
      : never
}

type InvalidateCbRegistrator = (cb: () => void) => void

export interface WatchOptionsBase {
  flush?: 'pre' | 'post' | 'sync'
  onTrack?: ReactiveEffectOptions['onTrack']
  onTrigger?: ReactiveEffectOptions['onTrigger']
}

export interface WatchOptions<Immediate = boolean> extends WatchOptionsBase {
  immediate?: Immediate
  deep?: boolean
}

export type WatchStopHandle = () => void

// Simple effect.
export function watchEffect(
  effect: WatchEffect,
  options?: WatchOptionsBase
): WatchStopHandle {
  return doWatch(effect, null, options)
}

// initial value for watchers to trigger on undefined initial values
const INITIAL_WATCHER_VALUE = {}

// overload #1: array of multiple sources + cb
// Readonly constraint helps the callback to correctly infer value types based
// on position in the source array. Otherwise the values will get a union type
// of all possible value types.
export function watch<
  T extends Readonly<Array<WatchSource<unknown> | object>>,
  Immediate extends Readonly<boolean> = false
>(
  sources: T,
  cb: WatchCallback<MapSources<T>, MapOldSources<T, Immediate>>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// overload #2: single source + cb
export function watch<T, Immediate extends Readonly<boolean> = false>(
  source: WatchSource<T>,
  cb: WatchCallback<T, Immediate extends true ? (T | undefined) : T>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// overload #3: watching reactive object w/ cb
export function watch<
  T extends object,
  Immediate extends Readonly<boolean> = false
>(
  source: T,
  cb: WatchCallback<T, Immediate extends true ? (T | undefined) : T>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// implementation
export function watch<T = any>(
  source: WatchSource<T> | WatchSource<T>[],
  cb: WatchCallback<T>,
  options?: WatchOptions
): WatchStopHandle {
  if (__DEV__ && !isFunction(cb)) {
    warn(
      `\`watch(fn, options?)\` signature has been moved to a separate API. ` +
        `Use \`watchEffect(fn, options?)\` instead. \`watch\` now only ` +
        `supports \`watch(source, cb, options?) signature.`
    )
  }
  return doWatch(source, cb, options)
}
/**
 * 实现监听数据的主要代码
 * 参考：https://cn.vuejs.org/api/reactivity-core.html#watch
 * @param source 第一个参数是侦听器的源。这个来源可以是以下几种：
 * 一个函数，返回一个值
 * 一个 ref
 * 一个响应式对象
 * 或是由以上类型的值组成的数组
 * @param cb 发生变化时要调用的回调函数。这个回调函数接受三个参数：新值、旧值，以及一个用于注册副作用清理的回调函数。该回调函数会在副作用下一次重新执行前调用，可以用来清除无效的副作用，例如等待中的异步请求。
 * @param param2 第三个可选的参数是一个对象，支持以下这些选项：
 * immediate：在侦听器创建时立即触发回调。第一次调用时旧值是 undefined。
 * deep：如果源是对象，强制深度遍历，以便在深层级变更时触发回调。
 * flush：调整回调函数的刷新时机。关于刷新时机参考：https://cn.vuejs.org/guide/essentials/watchers.html#callback-flush-timing
 * onTrack / onTrigger：调试侦听器的依赖。
 * @param instance 当前的响应式对象
 * @returns 
 */
function doWatch(
  source: WatchSource | WatchSource[] | WatchEffect,
  cb: WatchCallback | null,
  { immediate, deep, flush, onTrack, onTrigger }: WatchOptions = EMPTY_OBJ,
  instance = currentInstance
): WatchStopHandle {
  if (__DEV__ && !cb) {
    if (immediate !== undefined) {
      warn(
        `watch() "immediate" option is only respected when using the ` +
          `watch(source, callback, options?) signature.`
      )
    }
    if (deep !== undefined) {
      warn(
        `watch() "deep" option is only respected when using the ` +
          `watch(source, callback, options?) signature.`
      )
    }
  }

  const warnInvalidSource = (s: unknown) => {
    warn(
      `Invalid watch source: `,
      s,
      `A watch source can only be a getter/effect function, a ref, ` +
        `a reactive object, or an array of these types.`
    )
  }

  // 封装getter
  let getter: () => any
  const isRefSource = isRef(source)
  if (isRefSource) {
    // source为ref的情况下封装getter为箭头函数
    getter = () => (source as Ref).value
  } else if (isReactive(source)) {
    // source为响应式数据的情况下封装getter为箭头函数
    getter = () => source
    // 默认深响应
    deep = true
  } else if (isArray(source)) {
    // 解析array，将array中的数据解析开来，逐个封装为getter函数
    getter = () =>
      source.map(s => {
        if (isRef(s)) {
          return s.value
        } else if (isReactive(s)) {
          // 建立s的响应关系
          return traverse(s)
        } else if (isFunction(s)) {
          return callWithErrorHandling(s, instance, ErrorCodes.WATCH_GETTER)
        } else {
          __DEV__ && warnInvalidSource(s)
        }
      })
  } else if (isFunction(source)) {
    if (cb) {
      // getter with cb
      // 当前我们值分析在没有异常的情况下，getter的结果
      // 没有异常的情况下，getter = () => fn()
      // 为什么要运行fn呢？因为fn是副作用函数，我们要立刻调用track建立targetMap
      getter = () =>
        callWithErrorHandling(source, instance, ErrorCodes.WATCH_GETTER)
    } else {
      // no cb -> simple effect
      getter = () => {
        if (instance && instance.isUnmounted) {
          return
        }
        // cleanup存在的话肯定不是第一次调用cb了
        if (cleanup) {
          cleanup()
        }
        return callWithErrorHandling(
          source,
          instance,
          ErrorCodes.WATCH_CALLBACK,
          [onInvalidate]
        )
      }
    }
  } else {
    getter = NOOP
    __DEV__ && warnInvalidSource(source)
  }

  if (cb && deep) {
    const baseGetter = getter
    getter = () => traverse(baseGetter())
  }

  let cleanup: () => void
  // onInvalidate 用来注册清理失效时的回调
  // 注意onInvalidate的执行是在cb执行过程中进行的
  // 所以如果响应式数据没有被改变是不会触发cb的，也不会触发onInvalidate的执行，所以就不会为cleanup赋值
  // 第一次响应式数据源发生改变的话，cleanup是没有值的
  // 第二次响应式数据源发生改变，cleanup记录的是上一次onInvalidate的函数参数。
  // 所以可以使用onInvalidate将上次回调无用化。
  const onInvalidate: InvalidateCbRegistrator = (fn: () => void) => {
    cleanup = runner.options.onStop = () => {
      // 正常情况下返回的是fn
      callWithErrorHandling(fn, instance, ErrorCodes.WATCH_CLEANUP)
    }
  }

  // in SSR there is no need to setup an actual effect, and it should be noop
  // unless it's eager
  if (__NODE_JS__ && isInSSRComponentSetup) {
    if (!cb) {
      getter()
    } else if (immediate) {
      callWithAsyncErrorHandling(cb, instance, ErrorCodes.WATCH_CALLBACK, [
        getter(),
        undefined,
        onInvalidate
      ])
    }
    return NOOP
  }

  let oldValue = isArray(source) ? [] : INITIAL_WATCHER_VALUE
  const job: SchedulerJob = () => {
    if (!runner.active) {
      return
    }
    if (cb) {
      // watch(source, cb)
      // 执行副作用函数后获取的值是newValue，这里的新值是指响应式数据发生改变，触发副作用函数执行，执行以后会返回一个value，这个value就是newValue
      // 这里就充分利用了effect lazy选项
      const newValue = runner()
      if (deep || isRefSource || hasChanged(newValue, oldValue)) {
        // cleanup before running cb again
        // 调用回调函数之前先调用过期回调
        // 由上面的分析可以知道，cleanup记录着用户传入onInvalidate的函数参数，这里对cleanup的调用会改变上次cb执行时作用域的变量。
        if (cleanup) {
          cleanup()
        }
        // 正常情况下，这里执行的是cb(newValue, oldValue, onInvalidate)
        // 也就是用户在使用watch时传入的回调函数
        // 如果用户在cb中定义了onInvalidate，执行cb的过程将会执行onInvalidate
        // onInvalidate的执行过程见上面的代码分析
        callWithAsyncErrorHandling(cb, instance, ErrorCodes.WATCH_CALLBACK, [
          newValue,
          // pass undefined as the old value when it's changed for the first time
          // 第一次trigger cb oldValue是undefined
          oldValue === INITIAL_WATCHER_VALUE ? undefined : oldValue,
          onInvalidate
        ])
        // newValue退出舞台，在副作用函数执行后，变成了oldValue，oldValue被带入下次cb的执行
        oldValue = newValue
      }
    } else {
      // watchEffect
      // 如果cb不存在的话就调用副作用函数effect
      runner()
    }
  }

  // important: mark the job as a watcher callback so that scheduler knows it
  // it is allowed to self-trigger (#1727)
  job.allowRecurse = !!cb

  let scheduler: (job: () => any) => void
  if (flush === 'sync') {
    // 这里scheduler=job是为了实现什么功能呢？
    // 实现记录newValue和oldValue
    scheduler = job
  } else if (flush === 'post') {
    scheduler = () => queuePostRenderEffect(job, instance && instance.suspense)
  } else {
    // default: 'pre'
    scheduler = () => {
      if (!instance || instance.isMounted) {
        queuePreFlushCb(job)
      } else {
        // with 'pre' option, the first call must happen before
        // the component is mounted so it is called synchronously.
        job()
      }
    }
  }

  // watch 最终还是通过调用effect函数实现的响应式关系的建立
  // lazy为true，将包裹用户编写的函数fn的副作用函数返回，runner的执行才会触发副作用函数执行
  // scheduler是一个比较大的话题。背后对应的也有调度的思想。目前仅站在一个比较低的层次去看待这里的实现。
  const runner = effect(getter, {
    lazy: true,
    onTrack,
    onTrigger,
    scheduler
  })

  recordInstanceBoundEffect(runner)

  // initial run
  if (cb) {
    // 如果传入了immediate true选项，立刻调用job（封装了cb）
    // 否则调用副作用函数获取返回值，将其返回值作为oldValue，等下次调用cb的时候当做旧的值
    if (immediate) {
      job()
    } else {
      oldValue = runner()
    }
  } else if (flush === 'post') {
    // 意味着调度函数将副作用函数放在一个微任务队列中执行，并等待DOM更新结束后再执行
    queuePostRenderEffect(runner, instance && instance.suspense)
  } else {
    runner()
  }

  // watch 返回的stop可以终止数据的响应
  return () => {
    stop(runner)
    if (instance) {
      remove(instance.effects!, runner)
    }
  }
}

// this.$watch
export function instanceWatch(
  this: ComponentInternalInstance,
  source: string | Function,
  cb: Function,
  options?: WatchOptions
): WatchStopHandle {
  const publicThis = this.proxy as any
  const getter = isString(source)
    ? () => publicThis[source]
    : source.bind(publicThis)
  return doWatch(getter, cb.bind(publicThis), options, this)
}

// 仅仅递归读取value，触发track追踪，建立targetMap响应关系。
// seen是个缓存变量，用来记录读取过value
function traverse(value: unknown, seen: Set<unknown> = new Set()) {
  // 如果读取过了value，则什么都不做，直接返回value
  if (!isObject(value) || seen.has(value)) {
    return value
  }
  seen.add(value)
  // 考虑ref数据，读取的是ref.value
  if (isRef(value)) {
    traverse(value.value, seen)
  } else if (isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      traverse(value[i], seen)
    }
  } else if (isMap(value)) {
    value.forEach((_, key) => {
      // to register mutation dep for existing keys
      traverse(value.get(key), seen)
    })
  } else if (isSet(value)) {
    value.forEach(v => {
      traverse(v, seen)
    })
  } else {
    for (const key in value) {
      traverse(value[key], seen)
    }
  }
  return value
}
