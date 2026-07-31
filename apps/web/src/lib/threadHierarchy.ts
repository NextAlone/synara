// FILE: threadHierarchy.ts
// Purpose: Shared traversal helpers for parent/child thread relationships.

interface ThreadHierarchyNode<TId extends string> {
  readonly id: TId;
  readonly parentThreadId?: TId | null;
}

export function collectThreadSubtreeIds<TId extends string>(
  threads: readonly ThreadHierarchyNode<TId>[],
  rootThreadIds: Iterable<TId>,
): Set<TId> {
  const childrenByParentId = new Map<TId, TId[]>();
  for (const thread of threads) {
    if (!thread.parentThreadId) {
      continue;
    }
    const siblings = childrenByParentId.get(thread.parentThreadId) ?? [];
    siblings.push(thread.id);
    childrenByParentId.set(thread.parentThreadId, siblings);
  }

  const subtreeThreadIds = new Set(rootThreadIds);
  const pendingThreadIds = [...subtreeThreadIds];
  for (let index = 0; index < pendingThreadIds.length; index += 1) {
    const threadId = pendingThreadIds[index];
    if (!threadId) {
      continue;
    }
    for (const childThreadId of childrenByParentId.get(threadId) ?? []) {
      if (subtreeThreadIds.has(childThreadId)) {
        continue;
      }
      subtreeThreadIds.add(childThreadId);
      pendingThreadIds.push(childThreadId);
    }
  }

  return subtreeThreadIds;
}
