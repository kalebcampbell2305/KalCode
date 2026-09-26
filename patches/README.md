# cmdk 1.1.1 active descendant repair

`cmdk@1.1.1.patch` applies the same bounded change to the published ESM and CommonJS
distributions. pnpm pins its digest in the lockfile; there is no dependency version change.

In this version, the controlled `value` layout effect assigns the selected value without
refreshing `selectedItemId`. The internal selection path also computes that ID before later
filtered or force-mounted children finish committing. A highlighted result can therefore have
a missing ARIA reference, or a reference to a removed option. Root render effects alone do not
cover child-only commits or a remount with the same value and a different generated ID.

The added effect observes only the existing list's subtree, child additions/removals and
`aria-selected`/`id` changes. It publishes the committed selected option's ID only when it changes,
and disconnects on unmount. It does not change selection, focus, filtering, command execution,
or the document outside that list. Both existing ARIA owners consume the same store field.
The readable equivalent, using upstream descriptive variable names, is:

```tsx
React.useEffect(() => {
  const list = listInnerRef.current
  if (!list) return
  const refresh = () => {
    const id = getSelectedItem()?.id
    if (state.current.selectedItemId !== id) {
      state.current.selectedItemId = id
      store.emit()
    }
  }
  const observer = new MutationObserver(refresh)
  observer.observe(list, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['aria-selected', 'id'],
  })
  refresh()
  return () => observer.disconnect()
}, [])
```

The observation excludes the updated `aria-activedescendant` attributes, and publication is
guarded by equality, so emitting the correction cannot produce an observer loop.

Regression coverage: `apps/desktop/src/shell/cmdk-selection.test.tsx` exercises real ESM/CommonJS
menus through controlled replacement, same-value remount and removal; the browser suite
`command-palette-selection.spec.ts` checks asynchronous locator results, no results, named commands,
reopening, keyboard choice, focus and Enter. The existing dark/light rail-home axe gates reproduce
the original defect without the patch. Recheck these cases when upgrading cmdk and remove the
patch when the upstream version provides equivalent synchronization.
