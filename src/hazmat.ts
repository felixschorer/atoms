export const enum CacheType {
    VALUE,
    ERROR,
    UNINITIALIZED,
}

export interface CachedValue<T> {
    type: CacheType.VALUE
    value: T
    error: null
}

export interface CachedError {
    type: CacheType.ERROR
    value: null
    error: unknown
}

export interface Uninitialized {
    type: CacheType.UNINITIALIZED
    value: null
    error: null
}

export type Cache<T = unknown> = CachedValue<T> | CachedError | Uninitialized

export const enum NodeType {
    VALUE,
    DERIVED,
    EFFECT,
}

export interface SourceCommon<T> {
    /** current, possibly uncommitted value */
    value: T
    /** must be referentially equal to {@link value} when in committed state */
    committedValue: T
    /** keeps track of the subscribed targets and their subscription count */
    targets: Map<WeakRef<TargetNode>, number>
}

export interface TargetCommon {
    /** weak self reference */
    weakRef: WeakRef<this>
    /** sources which are tracked by the target */
    sources: Array<SourceNode>
    /** keeps track of invalidated sources, a {@link SourceNode} may be counted multiple times */
    invalidatedSourcesCount: number
    /** flag whether the target function is currently running, e.g. side effect or recompute */
    running: boolean
}

/**
 *                  setValue
 *                during batch
 * +-----------+ -------------> +-------------+
 * | validated |                | uncommitted |
 * +-----------+ <------------- +-------------+
 *                   commit
 */
export interface ValueNode<T = unknown> extends SourceCommon<T> {
    type: NodeType.VALUE
}

/**
 *                +----------+
 *       +------- | disposed | <-------+
 *       |        +----------+         |
 *       |                             |          revalidate
 *       v       invalidate src        |         during batch
 * +-----------+ -------------> +-------------+ -------------> +-------------+
 * | validated |                | invalidated |                | uncommitted |
 * +-----------+ <------------- +-------------+ <------------- +-------------+
 *       ^         revalidate                      rollback           |
 *       |      uninvalidate src               (invalidate src)       |
 *       |                                    (uninvalidate src)      |
 *       +------------------------------------------------------------+
 *                                  commit
 */
export interface DerivedNode<T = unknown> extends SourceCommon<Cache<T>>, TargetCommon {
    type: NodeType.DERIVED
    /** function to derive a new value */
    derive: () => T
    /** flag whether the node is currently being rolled back */
    rollback: boolean
}

/**
 *               invalidate src
 * +-----------+ -------------> +-------------+
 * | validated |                | invalidated |
 * +-----------+ <------------- +-------------+
 *                  runEffect
 *              uninvalidate src
 */
export interface EffectNode extends TargetCommon {
    type: NodeType.EFFECT
    /** callback to notify the effect that the tracked sources have changed */
    notify: () => void
    /** flag whether the node is currently tracking dependencies */
    tracking: boolean
}

export type SourceNode<T = unknown> = ValueNode<T> | DerivedNode<T>
export type TargetNode = DerivedNode | EffectNode

interface ExecutionContext {
    /** current target for tracking sources */
    currentTarget: TargetNode | null
    /** index into the sources array of {@link currentTarget} */
    sourceIndex: number
}

enum UpdateStatus {
    INACTIVE,
    ACTIVE,
    BATCHED,
}

interface UpdateContext {
    status: UpdateStatus
    /** sources which need to be committed at the end of the batch */
    uncommittedSources: Set<SourceNode>
    /** effects which need to be executed at the end of the batch */
    invalidatedEffects: Set<EffectNode>
    /** derived nodes which might be disposable */
    possiblyInvalidatedDerived: Set<DerivedNode>
}

const EXECUTION: ExecutionContext = {
    currentTarget: null,
    sourceIndex: 0,
}

const UPDATE: UpdateContext = {
    status: UpdateStatus.INACTIVE,
    uncommittedSources: new Set(),
    invalidatedEffects: new Set(),
    possiblyInvalidatedDerived: new Set(),
}

export function runInContext<T>(target: TargetNode, fn: () => T): T {
    if (target.running) {
        throw new Error("Cyclic dependency.")
    }

    const parentTarget = EXECUTION.currentTarget
    const parentSourceIndex = EXECUTION.sourceIndex

    target.running = true
    EXECUTION.currentTarget = target
    EXECUTION.sourceIndex = 0
    try {
        return fn()
    } finally {
        for (let i = EXECUTION.sourceIndex; i < target.sources.length; i++) {
            unsubscribe(target.sources[i]!, target)
        }
        target.sources.length = EXECUTION.sourceIndex

        target.running = false
        EXECUTION.currentTarget = parentTarget
        EXECUTION.sourceIndex = parentSourceIndex
    }
}

export function makeValueNode<T>(value: T): ValueNode<T> {
    return {
        type: NodeType.VALUE,
        value,
        committedValue: value,
        targets: new Map(),
    }
}

export function makeDerivedNode<T>(derive: () => T) {
    const value: Cache = { type: CacheType.UNINITIALIZED, value: null, error: null }
    const node: DerivedNode<T> = {
        type: NodeType.DERIVED,
        derive,
        value,
        committedValue: value,
        targets: new Map(),
        weakRef: null as never as WeakRef<DerivedNode<T>>,
        sources: [],
        invalidatedSourcesCount: 0,
        running: false,
        rollback: false,
    }
    node.weakRef = new WeakRef(node)
    return node
}

export function makeEffectNode(notify: () => void) {
    if (EXECUTION.currentTarget?.type === NodeType.DERIVED) {
        throw new Error("Cannot use effect in derived context.")
    }

    const node: EffectNode = {
        type: NodeType.EFFECT,
        notify,
        weakRef: null as never as WeakRef<EffectNode>,
        sources: [],
        invalidatedSourcesCount: 0,
        running: false,
        tracking: true,
    }
    node.weakRef = new WeakRef(node)
    return node
}

function isInvalidated(target: TargetNode): boolean {
    return target.invalidatedSourcesCount > 0
}

function isUncommitted(source: SourceNode): boolean {
    return source.value !== source.committedValue
}

function isInvalidatedOrUncommitted(source: SourceNode): boolean {
    return isUncommitted(source) || (source.type === NodeType.DERIVED && isInvalidated(source))
}

export function setValue<T>(valueNode: ValueNode<T>, value: T): T {
    if (EXECUTION.currentTarget?.type === NodeType.DERIVED) {
        throw new Error("Cannot set value in derived context.")
    }

    if (valueNode.value === value) return value

    valueNode.value = value

    if (UPDATE.status !== UpdateStatus.BATCHED) {
        UPDATE.status = UpdateStatus.ACTIVE
        valueNode.committedValue = value
        invalidate(valueNode)
        UPDATE.status = UpdateStatus.INACTIVE
        cleanupNodes()
        runEffects()
    } else if (valueNode.committedValue === value) {
        uninvalidate(valueNode)
    } else {
        invalidate(valueNode)
    }

    return value
}

function commitSources() {
    for (const source of UPDATE.uncommittedSources) {
        UPDATE.uncommittedSources.delete(source)
        source.committedValue = source.value
    }
}

function runEffects() {
    for (const effect of UPDATE.invalidatedEffects) {
        UPDATE.invalidatedEffects.delete(effect)
        runEffect(effect)
    }
}

function runEffect(effect: EffectNode) {
    if (!isInvalidated(effect)) return

    for (const source of effect.sources) {
        if (source.type === NodeType.DERIVED) {
            revalidate(source)
            if (!isInvalidated(effect)) return
        }
    }

    effect.invalidatedSourcesCount = 0
    effect.notify()
}

export function disposeEffect(effect: EffectNode) {
    for (const source of effect.sources) {
        unsubscribe(source, effect)
    }
}

function checkForDisposal(derived: DerivedNode) {
    if (!isInvalidated(derived) || derived.targets.size > 0) return

    if (UPDATE.status !== UpdateStatus.INACTIVE) {
        return UPDATE.possiblyInvalidatedDerived.add(derived)
    }

    for (const upstream of derived.sources) {
        unsubscribe(upstream, derived)
    }
    setUninitialized(derived)
    derived.sources.length = 0
}

function cleanupNodes() {
    for (const derived of UPDATE.possiblyInvalidatedDerived) {
        UPDATE.possiblyInvalidatedDerived.delete(derived)
        checkForDisposal(derived)
    }
}

function invalidate(source: SourceNode): void {
    if (source.type === NodeType.DERIVED && isInvalidated(source)) return
    if (source.type === NodeType.DERIVED && isUncommitted(source)) return rollback(source)

    for (const [targetRef, subscriptionCount] of source.targets) {
        const target = targetRef.deref()
        if (!target) {
            source.targets.delete(targetRef)
            continue
        }
        if (target.type === NodeType.DERIVED) {
            invalidate(target)
            checkForDisposal(target)
        } else {
            UPDATE.invalidatedEffects.add(target)
        }
        // Increase count only after recursively calling invalidate.
        // Otherwise, DerivedNodes won't pass the above isInvalidated check.
        target.invalidatedSourcesCount += subscriptionCount
    }
}

function uninvalidate(source: SourceNode) {
    for (const [targetRef, subscriptionCount] of source.targets) {
        const target = targetRef.deref()
        if (!target) {
            source.targets.delete(targetRef)
            continue
        }
        if (target.type === NodeType.DERIVED && isUncommitted(target)) {
            rollback(target)
        } else {
            target.invalidatedSourcesCount -= subscriptionCount
            if (target.type === NodeType.DERIVED && !isInvalidated(target)) {
                uninvalidate(target)
            }
        }
    }
}

function revalidate<T>(derived: DerivedNode<T>): void {
    if (derived.value.type !== CacheType.UNINITIALIZED && !isInvalidated(derived)) return
    try {
        const value = runInContext(derived, derived.derive)
        const unchanged =
            derived.value.type === CacheType.VALUE &&
            (derived.value.value === value || !isInvalidated(derived))

        if (unchanged) {
            uninvalidate(derived)
        } else {
            setDerivedValue(derived, value)
        }
    } catch (error) {
        if (derived.value.type === CacheType.ERROR && !isInvalidated(derived)) {
            uninvalidate(derived)
        } else {
            setDerivedError(derived, error)
        }
    } finally {
        derived.invalidatedSourcesCount = 0
    }
}

function setDerivedValue<T>(derived: DerivedNode<T>, value: T): void {
    if (UPDATE.status === UpdateStatus.BATCHED) {
        derived.value = { type: CacheType.VALUE, value, error: null }
    } else {
        ;(derived.value as CachedValue<T>).type = CacheType.VALUE
        ;(derived.value as CachedValue<T>).value = value
        ;(derived.value as CachedValue<T>).error = null
    }
}

function setDerivedError(derived: DerivedNode, error: unknown): void {
    if (UPDATE.status === UpdateStatus.BATCHED) {
        derived.value = { type: CacheType.ERROR, value: null, error }
    } else {
        ;(derived.value as CachedError).type = CacheType.ERROR
        ;(derived.value as CachedError).value = null
        ;(derived.value as CachedError).error = error
    }
}

function setUninitialized(derived: DerivedNode): void {
    if (UPDATE.status === UpdateStatus.BATCHED) {
        derived.value = { type: CacheType.UNINITIALIZED, value: null, error: null }
    } else {
        ;(derived.value as Uninitialized).type = CacheType.UNINITIALIZED
        ;(derived.value as Uninitialized).value = null
        ;(derived.value as Uninitialized).error = null
    }
}

function rollback(derived: DerivedNode): void {
    derived.value = derived.committedValue

    derived.rollback = true
    try {
        runInContext(derived, derived.derive)
    } finally {
        derived.rollback = false
        derived.invalidatedSourcesCount = 0
        for (const upstream of derived.sources) {
            if (isInvalidatedOrUncommitted(upstream)) {
                derived.invalidatedSourcesCount++
            }
        }
    }

    if (!isInvalidated(derived)) {
        return uninvalidate(derived)
    }

    for (const targetRef of derived.targets.keys()) {
        const target = targetRef.deref()
        if (!target) {
            derived.targets.delete(targetRef)
        } else if (target.type === NodeType.DERIVED && isUncommitted(target)) {
            rollback(target)
        }
    }
}

function subscribe(source: SourceNode, target: TargetNode) {
    const subscriptionCount = source.targets.get(target.weakRef)
    if (!subscriptionCount) {
        source.targets.set(target.weakRef, 1)
    } else {
        source.targets.set(target.weakRef, subscriptionCount + 1)
    }
}

function unsubscribe(source: SourceNode, target: TargetNode) {
    const subscriptionCount = source.targets.get(target.weakRef)
    if (!subscriptionCount) {
        return
    } else if (subscriptionCount > 1) {
        source.targets.set(target.weakRef, subscriptionCount - 1)
    } else {
        source.targets.delete(target.weakRef)
        if (source.type === NodeType.DERIVED) {
            checkForDisposal(source)
        }
    }
}

export function getValue<T>(source: SourceNode<T>): T {
    if (EXECUTION.currentTarget?.type === NodeType.DERIVED || EXECUTION.currentTarget?.tracking) {
        const sources = EXECUTION.currentTarget.sources
        const previousSource = sources[EXECUTION.sourceIndex]
        if (source !== previousSource) {
            sources[EXECUTION.sourceIndex] = source
            subscribe(source, EXECUTION.currentTarget)
            if (previousSource) {
                unsubscribe(previousSource, EXECUTION.currentTarget)
            }
        }
        EXECUTION.sourceIndex++
    }

    const rollback =
        EXECUTION.currentTarget?.type === NodeType.DERIVED && EXECUTION.currentTarget.rollback

    if (source.type === NodeType.VALUE) {
        return rollback ? source.committedValue : source.value
    } else {
        if (rollback) {
            return unwrapCache(source.committedValue)
        }
        revalidate(source)
        return unwrapCache(source.value)
    }
}

function unwrapCache<T>(cache: Cache<T>): T {
    switch (cache.type) {
        case CacheType.VALUE:
            return cache.value
        case CacheType.ERROR:
            throw cache.error
        case CacheType.UNINITIALIZED:
            throw new Error("Unwrapping uninitialized cache.")
    }
}

export function batch<T>(run: () => T): T {
    if (UPDATE.status === UpdateStatus.BATCHED) {
        return run()
    } else {
        UPDATE.status = UpdateStatus.BATCHED
        try {
            return run()
        } finally {
            UPDATE.status = UpdateStatus.INACTIVE
            commitSources()
            cleanupNodes()
            runEffects()
        }
    }
}

export function untracked<T>(run: () => T): T {
    const target = EXECUTION.currentTarget

    if (target?.type === NodeType.DERIVED) {
        throw new Error("Cannot disable tracking in derived context.")
    }

    if (!target?.tracking) return run()

    target.tracking = false
    try {
        return run()
    } finally {
        target.tracking = true
    }
}
