import { effect, ReactiveEffect, trigger, track } from './effect'
import { TriggerOpTypes, TrackOpTypes } from './operations'
import { Ref } from './ref'
import { isFunction, NOOP } from '@vue/shared'
import { ReactiveFlags, toRaw } from './reactive'

export interface ComputedRef<T = any> extends WritableComputedRef<T> {
  readonly value: T
}

export interface WritableComputedRef<T> extends Ref<T> {
  readonly effect: ReactiveEffect<T>
}

export type ComputedGetter<T> = (ctx?: any) => T
export type ComputedSetter<T> = (v: T) => void

export interface WritableComputedOptions<T> {
  get: ComputedGetter<T>
  set: ComputedSetter<T>
}

class ComputedRefImpl<T> {
  // _value是内存变量，用来缓存上一次计算的值
  private _value!: T
  // 用来标志是否需要重新计算值，true means 脏，默认情况下需要重新计算。在值没有
  private _dirty = true

  public readonly effect: ReactiveEffect<T>

  public readonly __v_isRef = true;
  public readonly [ReactiveFlags.IS_READONLY]: boolean

  constructor(
    getter: ComputedGetter<T>,
    private readonly _setter: ComputedSetter<T>,
    isReadonly: boolean
  ) {
    this.effect = effect(getter, {
      lazy: true,
      scheduler: () => {
        if (!this._dirty) {
          // 如果修改了响应式数据源，意味着this._value有可能发生改变。将this._dirty设置为true
          this._dirty = true
          // 当计算属性依赖的响应式数据发生改变的时候，调用trigger函数触发响应
          trigger(toRaw(this), TriggerOpTypes.SET, 'value')
        }
      }
    })

    this[ReactiveFlags.IS_READONLY] = isReadonly
  }

  // 添加计算属性value
  get value() {
    // this._dirty为true的时候，调用effect函数，重新计算_value的值
    if (this._dirty) {
      this._value = this.effect()
      // this._dirty为false，意味着下次用户可以直接使用缓存的_value，不用调用effect()重新计算
      this._dirty = false
    }
    // 访问计算属性value的时候手动追踪进行追踪
    track(toRaw(this), TrackOpTypes.GET, 'value')
    return this._value
  }

  // 设置值的时候，调用用户自己传进来的set方法
  // this._setter为用户自己传进来的方法
  set value(newValue: T) {
    this._setter(newValue)
  }
}
// ts的函数重载
// 根据代码可知，compute传参有两种情况。
// 用法参考：https://vue3js.cn/vue-composition-api/#computed
export function computed<T>(getter: ComputedGetter<T>): ComputedRef<T>
export function computed<T>(
  options: WritableComputedOptions<T>
): WritableComputedRef<T>
export function computed<T>(
  getterOrOptions: ComputedGetter<T> | WritableComputedOptions<T>
) {
  let getter: ComputedGetter<T>
  let setter: ComputedSetter<T>

  // 初始化getter，setter
  if (isFunction(getterOrOptions)) {
    getter = getterOrOptions
    setter = __DEV__
      ? () => {
          console.warn('Write operation failed: computed value is readonly')
        }
      : NOOP
  } else {
    getter = getterOrOptions.get
    setter = getterOrOptions.set
  }

  // 调用ComputedRefImpl实现compute
  // ComputedRefImpl第三个参数为isReadOnly，根据表达式可知，尽在getter function存在的情况下，isReadOnly为true
  return new ComputedRefImpl(
    getter,
    setter,
    isFunction(getterOrOptions) || !getterOrOptions.set
  ) as any
}
