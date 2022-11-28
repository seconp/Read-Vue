import { TrackOpTypes, TriggerOpTypes } from './operations'
import { EMPTY_OBJ, isArray, isIntegerKey, isMap } from '@vue/shared'

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Sets to reduce memory overhead.
// target: obj(obj本身是一个普通对象，但是只要被收集进来之后，经过处理会转化为响应式对象)
// key： obj.key
// dep: 副作用函数
type Dep = Set<ReactiveEffect>
type KeyToDepMap = Map<any, Dep>
// 使用WeakMap原因：当WeakMap中的key-value被pop出作用域之后（此时意味着target没有引用，用户此时不需要使用target），垃圾回收器会自动回收key-value占用的内存
// targetMap是一个收集副作用函数的数据结构
// target
// |- key
//    |- dep
const targetMap = new WeakMap<any, KeyToDepMap>()

// 定义了一些类型，TS提供了编辑类型的语法，这里定义的类型在稍后看代码的过程中会提供灵感，不用分析。
export interface ReactiveEffect<T = any> {
  (): T
  _isEffect: true
  id: number
  active: boolean
  raw: () => T
  deps: Array<Dep>
  options: ReactiveEffectOptions
}

export interface ReactiveEffectOptions {
  lazy?: boolean
  scheduler?: (job: ReactiveEffect) => void
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
  onStop?: () => void
  allowRecurse?: boolean
}

export type DebuggerEvent = {
  effect: ReactiveEffect
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
} & DebuggerEventExtraInfo

export interface DebuggerEventExtraInfo {
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

// 使用effectStack数据结构解决effect嵌套问题
// 原理：在本文件中使用的activeEffect记录当前的副作用函数。如果出现render(render封装了effect函数)嵌套的情况，eg：<foo><bar></bar></foo>导致的effect(effect())
// 目前是两层嵌套，意味着我们同一时刻需要有两个副作用函数，但是同一时刻activeEffect只能保存一个副作用函数，所有可能会出现明明应该触发外层副作用函数，但是触发了内层副作用函数的情况。
// 所以使用effectStack的栈顶保存当前的副作用函数。也就是当前的activeEffect
const effectStack: ReactiveEffect[] = []
// activeEffect记录当前正在运行的副作用函数
let activeEffect: ReactiveEffect | undefined

// 分析ITERATE_KEY的作用。
// 这里的ITERATE_KEY是为了起到唯一的作用，什么情况下需要这种唯一呢？在副作用函数中使用操作for in的时候，我们无法直接获取target对应的key。那么稍后在修改值的时候怎么重新触发副作用函数，触发 for in 呢？
// 解决的方法是：当访问for in建立的对象时，建立关系使之满足target-key之间是唯一的就可以。在修改属性的时候，找到这种唯一的关系，然后获取对应的effect集合。
// 注意，这里要求建立的是target-key之间的唯一关系，有可能出现key:target=1:n的关系。一个ITERATE_KEY供多个target使用。如果业务允许所有target都在一个作用域下，ITERATE_KEY只有一个。

export const ITERATE_KEY = Symbol(__DEV__ ? 'iterate' : '')
export const MAP_KEY_ITERATE_KEY = Symbol(__DEV__ ? 'Map key iterate' : '')

export function isEffect(fn: any): fn is ReactiveEffect {
  return fn && fn._isEffect === true
}

export function effect<T = any>(
  fn: () => T,
  options: ReactiveEffectOptions = EMPTY_OBJ
): ReactiveEffect<T> {
  if (isEffect(fn)) {
    fn = fn.raw
  }
  // 形成响应式数据的核心代码createReactiveEffect
  const effect = createReactiveEffect(fn, options)
  // 如果options中传输了lazy为true选项，将返回effect函数。如果lazy为false，means立即执行副作用函数。
  if (!options.lazy) {
    effect()
  }
  return effect
}

export function stop(effect: ReactiveEffect) {
  if (effect.active) {
    cleanup(effect)
    if (effect.options.onStop) {
      effect.options.onStop()
    }
    effect.active = false
  }
}

let uid = 0

function createReactiveEffect<T = any>(
  fn: () => T,
  options: ReactiveEffectOptions
): ReactiveEffect<T> {
  const effect = function reactiveEffect(): unknown {
    if (!effect.active) {
      return options.scheduler ? undefined : fn()
    }
    if (!effectStack.includes(effect)) {
      // 将effect从所有与之关联的集合中清除，动态建立targetMap和effect之间的关系。
      cleanup(effect)
      try {
        // 默认开启track
        enableTracking()
        // 参考对effectStack的分析
        effectStack.push(effect)
        // 参考对activeEffect的分析
        activeEffect = effect
        // 调用fn()获取其返回值，fn为用户自己编辑的函数
        return fn()
      } finally {
        // 这里处理了在fn()运行之后的逻辑。例如：弹出当前的副作用函数，重置当前的shouldTrack状态，记录栈顶的副作用函数
        // 这里处理的逻辑是为了解决运行过程中可能出现的异常。
        effectStack.pop()
        resetTracking()
        activeEffect = effectStack[effectStack.length - 1]
      }
    }
  } as ReactiveEffect
  effect.id = uid++
  effect._isEffect = true
  effect.active = true
  effect.raw = fn
  // 使用deps记录所有和effect相关联的集合，为cleanup做准备
  effect.deps = []
  effect.options = options
  // 返回effect函数，means 可以将effect的执行权利交给createReactiveEffect的调用方。
  return effect
}

/**
 * 副作用函数在运行过程中会被收集入targetMap数据结构中，建立target-key-effect之间的关系。
 * 当用户的响应式数据源改变的时候，通过响应式数据源target.key，找到对应的effect，然后执行effect
 * but
 * 之前收集的effect在后来的业务逻辑中可能不应该被触发。
 * eg: 代码业务逻辑中，再也访问不到target1.key1了，但是与之对应的的effect1还遗留在targetMap中，修改target1.key1还是会触发effect1。
 * so: 我们可以在每次effect运行的时候重新建立effect和targetMap的关系。
 * 这样一来我们需要做什么呢？
 * 需要将effect从所有相关联的集合Dep中清除。重新建立effect和targetMap的关系。
 * @param effect 当前正在准备运行的副作用函数
 */
function cleanup(effect: ReactiveEffect) {
  const { deps } = effect
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      deps[i].delete(effect)
    }
    deps.length = 0
  }
}

// 默认情况下应该通过track建立targetMap，shoudtrack means 是否允许使用track建立targetMap
let shouldTrack = true
// 之所以创建trackStack记录每个副作用函数是否应该被track，是因为同一时刻shouldTrack只能表示一种状态，但是嵌套的effect函数可能有需要在同一时刻记录多个shouldTrack。可以参考对effectStack的分析。
const trackStack: boolean[] = []

export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}
// 开启tracking，默认情况下所有的副作用函数都要被track，建立target-key-effect之间的关联
export function enableTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}
/**
 * proxy get handler
 * 建立targetMap数据结构
 * @param target 普通对象obj，响应式对象的源对象
 * @param type 
 * @param key 即将访问的属性
 */
export function track(target: object, type: TrackOpTypes, key: unknown) {
  // 没有通过createReactiveEffect函数执行fn，activeEffect为undefined
  // 调用pauseTracking之后，shouldTrack为false
  // ！shouldTrack 为判定当前不允许track操作
  if (!shouldTrack || activeEffect === undefined) {
    return
  }
  let depsMap = targetMap.get(target)
  if (!depsMap) {
    targetMap.set(target, (depsMap = new Map()))
  }
  let dep = depsMap.get(key)
  if (!dep) {
    depsMap.set(key, (dep = new Set()))
  }
  if (!dep.has(activeEffect)) {
    dep.add(activeEffect)
    // 想当前副作用函数的deps栈中压入与之关联的Set<dep>，未来cleanup做准备
    activeEffect.deps.push(dep)
    // 在这里运行onTrack钩子函数，只有在开发模式下才能运行onTrack
    if (__DEV__ && activeEffect.options.onTrack) {
      activeEffect.options.onTrack({
        effect: activeEffect,
        target,
        type,
        key
      })
    }
  }
}

/**
 * proxy set handler
 * 响应数据源发生改变时，根据targetMap触发effect
 * @param target 响应式对象的数据源对象
 * @param type 操作的类型，对于数组或者map而言有增删改的操作类型
 * @param key 设置的属性/ITERATE_KEY/MAP_KEY_ITERATE_KEY
 * @param newValue 修改后的值
 * @param oldValue 修改前的值
 * @param oldTarget 
 * @returns 
 */
export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>
) {
  const depsMap = targetMap.get(target)
  if (!depsMap) {
    // never been tracked
    return
  }

  const effects = new Set<ReactiveEffect>()
  const add = (effectsToAdd: Set<ReactiveEffect> | undefined) => {
    if (effectsToAdd) {
      effectsToAdd.forEach(effect => {
        // 如果触发关联的effect是当前正在执行的，并且没有声明允许递归则不在重复执行
        // allowRecurse为true且有自定义调度器时，将执行钩子和自定义调度器，允许递归有效。否则单纯地允许allowRecurse为true且没有调度器将会导致函数无限循环
        // 无限循环的原因：副作用函数中出现了target.key++语句。
        // 分析原因：target.key++等价于target.key(设置值触发trigger) = target.key(读取值触发track) + 1。
        // 在副作用函数中首先track时建立effect关联，紧接着trigger，trigger执行的过程中会调用副作用函数（之前的副作用函数还在trigger阶段，没有执行完毕），副作用函数运行target.key++会再次建立effect关联......
        // 导致之前的副作用函数没有执行完毕，由trigger触发的副作用函数已经压栈。
        if (effect !== activeEffect || effect.options.allowRecurse) {
          effects.add(effect)
        }
      })
    }
  }

  if (type === TriggerOpTypes.CLEAR) {
    // collection being cleared
    // trigger all effects for target
    depsMap.forEach(add)
  } else if (key === 'length' && isArray(target)) {
    // 如果target是数组且修改了数组的length属性
    depsMap.forEach((dep, key) => {
      // dep-mapValue；key-mapKey；newValue-修改的length值
      // 如果修改数组的length，所有索引大于length值的元素都要触发副作用函数
      // 索引小于length值的元素，不触发响应。
      // eg：arr=['aa']; 设置arr.length=0，则导致arr第0个元素被删除，因此触发响应。但是arr.length=2的话，不会影响已有的元素，不用执行副作用函数。
      if (key === 'length' || key >= (newValue as number)) {
        add(dep)
      }
    })
  } else {
    // schedule runs for SET | ADD | DELETE
    if (key !== void 0) {
      add(depsMap.get(key))
    }

    // also run for iteration key on ADD | DELETE | Map.SET
    // 可以执行add操作的对象有，普通对象，数组。
    // 对于for in操作，如果拦截的对象新添加了属性，
    // 可以执行set操作的对象有，普通对象，数组。
    // 对于for in操作，如果拦截的对象设置了原有属性，
    // 可以执行delete操作的对象有，
    switch (type) {
      case TriggerOpTypes.ADD:
        if (!isArray(target)) {
          add(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            add(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        } else if (isIntegerKey(key)) {
          // new index added to array -> length changes
          add(depsMap.get('length'))
        }
        break
      case TriggerOpTypes.DELETE:
        if (!isArray(target)) {
          add(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            add(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        }
        break
      case TriggerOpTypes.SET:
        if (isMap(target)) {
          add(depsMap.get(ITERATE_KEY))
        }
        break
    }
  }

  const run = (effect: ReactiveEffect) => {
    if (__DEV__ && effect.options.onTrigger) {
      effect.options.onTrigger({
        effect,
        target,
        key,
        type,
        newValue,
        oldValue,
        oldTarget
      })
    }
    if (effect.options.scheduler) {
      // 被触发引起effect要重新收集依赖时的调度器，当传入时effect收到触发时不会重新执行监听函数而是执行这个function，由用户自己调度。
      effect.options.scheduler(effect)
    } else {
      // 如果不存在scheduler，默认执行副作用函数
      effect()
    }
  }

  // 执行副作用函数，这里遍历的是effects
  // effects是从depsMap中获取的，为什么不去直接遍历depsMap呢？
  // 加入遍历的是depsMap：depsMap中保存着key-Set<effect>之间的关联，设置target.key触发trigger函数，遍历depsMap取出副作用函数并执行，执行过程中会调用cleanup清除副作用函数和Set之间的关联。
  // 清除之后，副作用函数中读取target.key会向depsMap中添加副作用函数，此时
  // 代码 depsMap.foreach(dep=>{运行dep[key]对应的副作用函数}) 并没有执行完毕，结果就是depsMap清除关联之后，立刻又添加了关联，导致代码无限执行。
  // 所以这里使用的是effects来获取trigger过程中需要执行的副作用函数，然后遍历effects运行副作用函数，运行的过程中向depsMap中删除&添加关联对effects无影响。
  effects.forEach(run)

}