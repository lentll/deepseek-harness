/**
 * Injected into the Web application after every load.
 *
 * Upstream offers no way to delete a Session: the row menu lists pin, rename,
 * fork, copy id, reveal in folder and archive. Archiving only hides a Session,
 * which leaves the log on the stick forever. This fragment adds the missing
 * entry to the row menu the application already renders, and nothing else:
 *
 *   - the Session id comes from the row's own `data-row-key="session:<id>"`,
 *     captured when the row's menu trigger is pressed, so the entry always
 *     targets the row the user right-clicked;
 *   - the entry is cloned from the existing archive entry, so it inherits the
 *     menu's classes, spacing, icon slot and hover behaviour instead of
 *     re-implementing the design;
 *   - the click is handed to the host through the preload bridge, the host
 *     confirms with a native dialog, and only a confirmed delete reloads the
 *     page so the list reflects the disk.
 *
 * The fragment is idempotent: re-injecting on the same document is a no-op, and
 * a menu that does not belong to a Session is left untouched.
 */
(() => {
  if (window.__dshPortableDeleteSession === true) return 'already-installed'
  window.__dshPortableDeleteSession = true

  const SESSION_PREFIX = 'session:'
  const LABEL = '删除会话'
  const ICON = 'dsw-icon-trash-outline-regular'
  const DANGER = 'var(--dsw-alias-state-error-primary, #e5484d)'

  let targetId = ''
  let targetTitle = ''

  /** Remember which Session owns the menu that is about to open. */
  function remember(trigger) {
    const row = trigger.closest('[data-row-key^="' + SESSION_PREFIX + '"]')
    if (row === null) {
      targetId = ''
      targetTitle = ''
      return
    }
    const key = row.getAttribute('data-row-key') ?? ''
    targetId = key.slice(SESSION_PREFIX.length)
    const titleNode = row.querySelector('[class*="title"]')
    targetTitle = titleNode === null ? '' : (titleNode.textContent ?? '').trim()
  }

  // Capture phase: the row records the target before any menu mounts, and a
  // pointerdown on a workspace row clears it so a workspace menu never inherits
  // a stale Session.
  document.addEventListener(
    'pointerdown',
    (event) => {
      const trigger = event.target instanceof Element ? event.target.closest('[data-context-menu-trigger]') : null
      if (trigger === null) return
      remember(trigger)
    },
    true,
  )

  // Keyboard users open the same menu with Enter or Space on the trigger.
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      const trigger = event.target instanceof Element ? event.target.closest('[data-context-menu-trigger]') : null
      if (trigger === null) return
      remember(trigger)
    },
    true,
  )

  /** Close the open menu the way Escape does, without a synthetic outside click. */
  function dismissMenu() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  }

  /** Hand one confirmed delete to the host, then reload so the list matches disk. */
  async function remove() {
    const id = targetId
    if (id.length === 0) return
    dismissMenu()
    const bridge = window.dshPortable
    if (bridge === undefined || typeof bridge.deleteSession !== 'function') {
      console.error('portable: the delete bridge is missing; rebuild the shell')
      return
    }
    try {
      const outcome = await bridge.deleteSession(id, targetTitle)
      // The host restarts the runtime after a delete, which already reloads this
      // page; `reloaded` says so. Only a host that could not restart leaves the
      // stale list on screen, and then a plain reload is the best fallback.
      if (outcome?.deleted === true && outcome.reloaded !== true) window.location.reload()
      else if (outcome?.deleted !== true && outcome?.reason !== 'cancelled') console.warn('portable: delete skipped:', outcome?.reason)
    } catch (error) {
      console.error('portable: delete failed', error)
    }
  }

  /** Add the delete entry to a Session menu, cloned from its archive entry. */
  function decorate(menu) {
    if (menu.dataset.portableDelete === 'done' || targetId.length === 0) return
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]'))
    const archive = items.find((item) => (item.textContent ?? '').includes('归档会话')) ?? items.find((item) => (item.textContent ?? '').includes('取消归档'))
    if (archive === undefined) return
    const wrap = archive.parentElement
    if (wrap === null || wrap.parentElement === null) return

    menu.dataset.portableDelete = 'done'
    const entry = wrap.cloneNode(true)
    const button = entry.querySelector('[role="menuitem"]')
    if (button === null) return
    button.removeAttribute('data-dsh-automatic-focus')
    button.removeAttribute('aria-keyshortcuts')
    button.style.color = DANGER
    entry.querySelector('[class*="shortcut"]')?.remove()

    const label = entry.querySelector('[class*="itemLabel"]')
    if (label !== null) label.textContent = LABEL
    const icon = entry.querySelector('svg')
    if (icon !== null) icon.setAttribute('data-icon', ICON)
    entry.querySelector('use')?.setAttribute('href', '#' + ICON)

    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      void remove()
    })

    wrap.after(entry)
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue
        const menu = node.matches('[role="menu"][data-context-menu]')
          ? node
          : node.querySelector('[role="menu"][data-context-menu]')
        if (menu !== null) decorate(menu)
      }
    }
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })

  return 'installed'
})()
