---
source: https://milkdown.dev/docs/api/ctx
fetched: 2026-05-23
milkdown_version: 7.20.0
title: "@milkdown/ctx"
---

# @milkdown/ctx

## Slice

#### class Container



Container is a map of slices.

 * **`get`**`<T, N extends string = string>(slice: SliceType | N) → Slice`\
   Get a slice from the container by slice type or slice name.

 * **`remove`**`<T, N extends string = string>(slice: SliceType | N)`\
   Remove a slice from the container by slice type or slice name.

 * **`has`**`<T, N extends string = string>(slice: SliceType | N) → boolean`\
   Check if the container has a slice by slice type or slice name.


#### class SliceType`<T = any, N extends string = string>`



Slice type can be used to create slices in different containers.

 * `new `**`SliceType`**`(value: T, name: N)`\
   Create a slice type with a default value and a name.
   The name should be unique in the container.

 * **`id`**`: Symbol`\
   The unique id of the slice type.

 * **`name`**`: N`\
   The name of the slice type.

 * **`create`**`(container: SliceMap, value?: T = this._defaultValue) → Slice`\
   Create a slice with a container.
   You can also pass a value to override the default value.

#### class Slice`<T = any, N extends string = string>`



Slice is a value of slice type.

 * **`type`**`: SliceType`\
   The type of the slice.

 * **`on`**`(watcher: fn(value: T) → unknown) → fn()`\
   Add a watcher for changes in the slice.
   Returns a function to remove the watcher.

 * **`once`**`(watcher: fn(value: T) → unknown) → fn()`\
   Add a one-time watcher for changes in the slice.
   The watcher will be removed after it is called.
   Returns a function to remove the watcher.

 * **`off`**`(watcher: fn(value: T) → unknown)`\
   Remove a watcher.

 * **`offAll`**`()`\
   Remove all watchers.

 * **`set`**`(value: T)`\
   Set the value of the slice.

 * **`get`**`() → T`\
   Get the value of the slice.

 * **`update`**`(updater: fn(prev: T) → T)`\
   Update the value of the slice with a callback.

 #### createSlice `<T = any, N extends string = string>(value: T, name: N) → SliceType`
   Create a slice type with a default value and a name.
   This is equivalent to `new SliceType(value, name)`.


## Timer

#### class Clock



Container is a map of timers.

 * **`get`**`(timer: TimerType) → Timer`\
   Get a timer from the clock by timer type.

 * **`remove`**`(timer: TimerType)`\
   Remove a timer from the clock by timer type.

 * **`has`**`(timer: TimerType) → boolean`


#### class TimerType



Timer type can be used to create timers in different clocks.

 * `new `**`TimerType`**`(name: string, timeout?: number = 3000)`\
   Create a timer type with a name and a timeout.
   The name should be unique in the clock.

 * **`id`**`: Symbol`\
   The unique id of the timer type.

 * **`name`**`: string`\
   The name of the timer type.

 * **`timeout`**`: number`\
   The timeout of the timer type.

 * **`create`**`(clock: TimerMap) → Timer`\
   Create a timer with a clock.

#### class Timer



Timer is a promise that can be resolved by calling done.

 * **`type`**`: TimerType`\
   The type of the timer.

 * **`status`**`: TimerStatus`\
   The status of the timer.
   Can be `pending`, `resolved` or `rejected`.

 * **`start`**`() → Promise`\
   Start the timer, which will return a promise.
   If the timer is already started, it will return the same promise.
   If the timer is not resolved in the timeout, it will reject the promise.

 * **`done`**`()`\
   Resolve the timer.

 #### createTimer `(name: string, timeout?: number = 3000) → TimerType`
   Create a timer type with a name and a timeout.
   This is equivalent to `new TimerType(name, timeout)`.


---

## Ctx

#### class Ctx



The ctx object that can be accessed in plugin and action.

 * `new `**`Ctx`**`(container: Container, clock: Clock, meta?: Meta)`\
   Create a ctx object with container and clock.

 * **`meta`**`: Meta | undefined`\
   Get metadata of the ctx.

 * **`inspector`**`: Inspector | undefined`\
   Get the inspector of the ctx.

 * **`produce`**`(meta?: Meta) → Ctx`\
   Produce a new ctx with metadata.
   The new ctx will link to the same container and clock with the current ctx.
   If the metadata is empty, it will return the current ctx.

 * **`inject`**`<T>(sliceType: SliceType, value?: NonNullable) → Ctx`\
   Add a slice into the ctx.

 * **`remove`**`<T, N extends string = string>(sliceType: SliceType | N) → Ctx`\
   Remove a slice from the ctx.

 * **`record`**`(timerType: TimerType) → Ctx`\
   Add a timer into the ctx.

 * **`clearTimer`**`(timerType: TimerType) → Ctx`\
   Remove a timer from the ctx.

 * **`isInjected`**`<T, N extends string = string>(sliceType: SliceType | N) → boolean`\
   Check if the ctx has a slice.

 * **`isRecorded`**`(timerType: TimerType) → boolean`\
   Check if the ctx has a timer.

 * **`use`**`<T, N extends string = string>(sliceType: SliceType | N) → Slice`\
   Get a slice from the ctx.

 * **`get`**`<T, N extends string>(sliceType: SliceType | N) → T`\
   Get a slice value from the ctx.

 * **`set`**`<T, N extends string>(sliceType: SliceType | N, value: T)`\
   Get a slice value from the ctx.

 * **`update`**`<T, N extends string>(sliceType: SliceType | N, updater: fn(prev: T) → T)`\
   Update a slice value from the ctx by a callback.

 * **`timer`**`(timer: TimerType) → Timer`\
   Get a timer from the ctx.

 * **`done`**`(timer: TimerType)`\
   Resolve a timer from the ctx.

 * **`wait`**`(timer: TimerType) → Promise`\
   Start a timer from the ctx.

 * **`waitTimers`**`(slice: SliceType) → Promise`\
   Start a list of timers from the ctx, the list is stored in a slice in the ctx.
   This is equivalent to

   ```typescript
   Promise.all(ctx.get(slice).map(x => ctx.wait(x))).
   ```


---

## Plugin Types

 #### type MilkdownPlugin` = {meta?: Meta} & fn(ctx: Ctx) → CtxRunner`
   The type of the plugin.

   ```typescript
   // A full plugin example
   const plugin1 = (ctx: Ctx) => {
     // setup
     return async () => {
       // run
       return async () => {
         // cleanup
       }
     }
   }

   // A plugin doesn't need to return a cleanup function
   const plugin2 = (ctx: Ctx) => {
     // setup
     return async () => {
       // run
     }
   }

   // A plugin doesn't need to be async
   const plugin3 = (ctx: Ctx) => {
     // setup
     return () => {
       // run
     }
   }
   ```


## Inspector

#### class Inspector



The inspector object that is used to inspect the runtime environment of a ctx.

 * `new `**`Inspector`**`(container: Container, clock: Clock, meta: Meta)`\
   Create an inspector with container, clock and metadata.

 * **`read`**`() → Telemetry`\
   Read the runtime telemetry as an object of the ctx.

#### interface Telemetry



 * **`metadata`**`: Meta`

 * **`injectedSlices`**`: {name: string, value: unknown}[]`

 * **`consumedSlices`**`: {name: string, value: unknown}[]`

 * **`recordedTimers`**`: {name: string, duration: number, status: TimerStatus}[]`

 * **`waitTimers`**`: {name: string, duration: number, status: TimerStatus}[]`

#### interface Meta



The metadata of the plugin.

 * **`displayName`**`: string`\
   The name of the plugin

 * **`description`**`?: string`\
   The description of the plugin

 * **`package`**`: string`\
   The package that the plugin belongs to

 * **`group`**`?: string`\
   The group of the plugin, internal plugins will be grouped by `System`

 * **`additional`**`?: Record`\
   Any additional metadata

 #### type TimerStatus` = "pending" | "resolved" | "rejected"`
