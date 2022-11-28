# @vue/reactivity

## Usage Note

This package is inlined into Global & Browser ESM builds of user-facing renderers (e.g. `@vue/runtime-dom`), but also published as a package that can be used standalone. The standalone build should not be used alongside a pre-bundled build of a user-facing renderer, as they will have different internal storage for reactivity connections. A user-facing renderer should re-export all APIs from this package.

For full exposed APIs, see `src/index.ts`. You can also run `yarn build reactivity --types` from repo root, which will generate an API report at `temp/reactivity.api.md`.

## Credits

The implementation of this module is inspired by the following prior art in the JavaScript ecosystem:

- [Meteor Tracker](https://docs.meteor.com/api/tracker.html)
- [nx-js/observer-util](https://github.com/nx-js/observer-util)
- [salesforce/observable-membrane](https://github.com/salesforce/observable-membrane)

## Caveats

- Built-in objects are not observed except for `Array`, `Map`, `WeakMap`, `Set` and `WeakSet`.

# @vue/reactivity/note

## 进度

- [x] 响应系统核心代码：effect&track&trigger&targetMap数据结构
- [x] 普通对象拦截器：baseHandler
- [x] 原始值拦截过程：for ref
- [x] 部分数组拦截过程：for array
- [ ] map/set拦截过程：collectionHandler

> 分析的bug包括：
>
> - 调用cleanup动态清除副作用函数依赖关系，防止出现多次调用副作用函数
>
> - 在trigger函数中添加effects集合，防止在被触发执行的副作用函数在执行完毕前向targetMap中添加effect set，导致遍历effect set会出现无限循环的情况
>
> - 自增/减操作引起的无限循环
>
> - 嵌套的副作用函数引起的调用bug
>
> - 修改数组length导致的bug
>
> - 根据数组index索引修改数据引起的bug
>
> - 解析结构引起的响应丢失问题
>
> - 自动解决ref value问题
>
>     ......

