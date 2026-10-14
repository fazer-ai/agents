# Modals

The `<Modal>` component in `src/client/components/Modal.tsx` is the canonical wrapper for Radix Dialog. State is owned by a controller hook in the parent, and descendants pick it up via context. The shape:

```tsx
const modal = useModalController<License>();          // parent owns state

<Button onClick={() => modal.open(license)}>Open</Button>
<LicenseModal modal={modal} />                        // ALWAYS rendered

function LicenseModal({ modal }: { modal: ModalController<License> }) {
  return (
    <Modal modal={modal} title="Attach license">
      <Body />
    </Modal>
  );
}

function Body() {
  const { payload: license, close } = useModal<License>();   // any descendant
  // ...
}
```

## Rules

- **Always render the `<Modal>`, never `{flag && <Modal/>}`**. Radix keeps `Dialog.Root` alive through the exit animation via its internal `Presence` component. Unmounting the root skips the animation and snaps the modal closed. (This is why the `HelpFab` in older code animated correctly while newer wrappers didn't.)
- **`useModalController<T>(opts?)`** returns `{ isOpen, payload, open, close }`. `payload` is retained across `close()` so the body can keep rendering real data while Radix plays the exit animation; it's only overwritten on the next `open()`. Don't clear it in `close()`.
- **`useModal<T>()`** is the descendant hook. Reads the controller from context that `<Modal>` provides. Use it in body/footer/submodals to avoid prop drilling. Throws if used outside a `<Modal modal={...}>` subtree.
- **`useOnModalOpen(modal, effect)`** fires `effect` each time the controller's `isOpen` transitions from `false` to `true` (with optional cleanup on close). Use it for per-open state resets (form defaults, prefilled fields, etc.). It takes the controller directly (not `modal.isOpen`) because the hook is typically called in the wrapper component *before* `<Modal>` mounts its context provider; tried the context-only variant but it crashes at runtime for that reason. Don't reach for `useEffect(..., [modal.isOpen])` by hand; `useOnModalOpen` makes the intent explicit and is the pattern the biome plugin recognizes.
- **Reset state on the next open, not in the close handler.** Flipping disclosure/expansion state (`showAdvanced`, `isExpanded`, form sections) synchronously inside the close callback runs during Radix's exit animation, so the panel snaps shut mid-fade (visible flicker). Push those resets into `useOnModalOpen` instead; the modal is hidden between close and the next open, so the reset is invisible. This is also why `close()` on the controller does not clear `payload`: Radix needs to keep rendering real data through the animation.
- **`closeOnOutsideClick={false}`** for flows where accidental dismiss is costly (pricing, checkout, destructive confirmation). Esc still closes.
- **`onCloseRequest`** intercepts user-driven close (Esc, outside click, X). The handler is responsible for eventually calling `modal.close()` (or not), typically after a confirmation submodal. Programmatic `modal.close()` calls from the parent are unaffected.
- **`busy`** says a request this modal started is in flight. Every user-driven close (Esc, outside click, X, Cancel, Back) does nothing and the discard prompt never opens; the unload prompt stays armed while dirty. It takes precedence over `unsavedChanges` and `onCloseRequest`, and it holds the console's own reloads of a stale tab, clean form included (docs/routing.md, "A tab older than the server").
- **Footer "Cancel" must close through the guard, never `modal.close()` directly.** `modal.close()` is a PROGRAMMATIC close: it bypasses the unsaved-changes confirmation by design (the parent calls it after a successful save). A footer/body "Cancel" button is a USER-driven close, so it must funnel through the same guard as Esc/outside/X — otherwise a dirty form is discarded silently and item-27-class bugs reappear. Use the **`<ModalCancelButton>`** primitive (renders a `secondary` Button, label defaults to `common.cancel`, accepts `disabled`/`children`), or call **`useModalClose()`** from any component rendered inside the `<Modal>` subtree (footer prop included — it renders inside the Modal's context providers, even though the JSX is authored in the parent). The hook returns `requestClose`, so a dirty form gets the "discard changes?" prompt and a clean form closes immediately. Reserve a raw `modal.close()` for the post-success "Done" button on modals that hold nothing dirty.

Nested modals stack automatically: `<Modal>` reads a depth from context and computes its `z-index` as `calc(var(--z-modal) + depth * 2)`. The overlay sits one step below the content. A warning fires once nesting depth reaches 5 (which collides with `--z-toast` at 90). If you need deeper nesting, bump the z-index tokens in `public/index.css` instead of silencing the warning.

Enforced by `biome-plugins/always-render-modal.grit` (scoped to `src/client/**`): any JSX element whose name matches `*Modal` (or the bare `<Modal>`) wrapped in a `{cond && ...}` short-circuit or a `{cond ? ... : null}` ternary fails lint. The plugin rejects the unmount-on-close anti-pattern directly; the fix is to lift state into `useModalController` and always render the wrapper.

## Async flows (future guidance)

The template's two modals (HomePage playground and `SupportModal`) are sync; the patterns below aren't needed for them. They come from ~7 rounds of review on heavily-async modals in a downstream project and are worth reaching for once a modal starts fetching or mutating on the backend. Keep the list by your side when you add the first "modal that makes an API call" to your app.

- **Drop stale responses with a session token.** Bump a `sessionRef = useRef(0)` in `useOnModalOpen` (and inside any action that re-fetches). Async callbacks capture the current token; on return, bail if `sessionRef.current` changed. Prevents close+reopen races and payload switches from flashing wrong data or spawning child modals for the wrong entity.
- **Parent close invalidates nested state.** When a modal owns child modals (parent opens a nested one while open), return a cleanup from `useOnModalOpen` that bumps the session token and calls `child.close()`. Without this, child dialogs linger past the parent session.
- **Guard user-driven close while loading.** During an in-flight request, pass `busy={loading}` AND `disabled={loading}` on Cancel/Confirm/row triggers. The typical bug this catches: a stale `onSuccess` firing and closing a freshly reopened session. Never a no-op `onCloseRequest` for this: `unsavedChanges` takes precedence over it, so on a dirty form Esc, the overlay and the X open the discard prompt, and "Discard" closes the modal with the write still on its way (#1439). The lint rule `no-noop-close-request` refuses the idiom.
- **Confirm modals: close only on success.** Handlers for confirm-delete/detach/disable return `boolean`; the parent closes the confirm modal only on `true`. Failures stay on-screen so the user can retry without re-opening.
- **Skip resync effects when closing.** If the parent effect that writes into the modal's state runs during close (typical on a refetch-on-data-change pattern), guard it with `if (!isOpen) return`. Otherwise a late fetch can resurrect a modal mid-animation.
- **`useOnModalOpen` + `useEffect([payload.id])` together.** `useOnModalOpen` catches reopen transitions only. For modals that stay open across in-place payload swaps (`open(newPayload)` without closing first), pair it with a `useEffect` keyed on the payload's identity so state resets in both cases.
- **Force re-fetch on reopen by listing `modal.isOpen` in `fetchData` deps.** The instance-id / user-id driving `fetchData` stays the same across close+reopen, so a naive `useCallback([id])` won't re-run. Include `modal.isOpen` in the dep list (and in the effect that calls it) so the false→true transition re-fires the fetch. A separate `fetchCounter` ref bumped in `useOnModalOpen` works too, but double-fires when the id also changes in a separate render pass; prefer `modal.isOpen` alone.
- **Reset state synchronously with `useLayoutEffect`.** For state that would flash the previous session's content during the close→reopen paint window (e.g. `loading`, `products`, `error`), reset it from `useLayoutEffect` keyed on `isOpen` instead of `useEffect`. Also bump any `fetchSessionRef` in the same layout effect so in-flight requests from the prior session are invalidated before the new paint commits.
- **URL-driven auto-open is mount-only.** Effects that open a modal from a URL param (`?cart=1` → open acquire modal) should run once on mount (`[]` deps). Including the modal controller in deps re-runs on every open/close.
- **Check the `{ error }` branch from the typed client.** Elysia's typed client returns `{ data, error }` from mutations. Inside a modal's submit handler, inspect `error` explicitly, surface the API message, and do NOT close the modal on error.
- **Prefer titled modals.** Every modal in practice ended up with a title; `ariaLabel`-only flows needed shims and drifted visually. The template keeps `title?: string` optional for flexibility, but the default answer is "give it a title".
