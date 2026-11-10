/**
 * Injected into the Web application after every load.
 *
 * Upstream offers no way to delete a Session: the row menu lists pin, rename,
 * fork, copy id, reveal in folder and archive. Archiving only hides a Session,
 * which leaves the log on the stick forever. This fragment adds the missing
 * entry to the row menu the application already renders, and nothing else:
 *
 *   - the Session id comes from the row's own `data-row-key="session:<id>"`,
 *     captured when the row is right-clicked or its menu trigger is pressed, so
 *     the entry always targets the row the user acted on;
 *   - the entry is cloned from the existing archive entry, so it inherits the
 *     menu's classes, spacing, icon slot and hover behaviour instead of
 *     re-implementing the design;
 *   - the click is handed to the host through the preload bridge, the host
 *     confirms with a native dialog, and the row is dropped from the list as
 *     soon as the host answers — the host then restarts dsh in the background,
 *     which reloads the page once the new server is up.
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

  /** Remember the Session a row stands for. */
  function rememberRow(row) {
    const key = row.getAttribute('data-row-key') ?? ''
    targetId = key.startsWith(SESSION_PREFIX) ? key.slice(SESSION_PREFIX.length) : ''
    const titleNode = row.querySelector('[class*="title"]')
    targetTitle = titleNode === null ? '' : (titleNode.textContent ?? '').trim()
  }

  /** Remember which Session owns the menu that is about to open. */
  function remember(trigger) {
    const row = trigger.closest('[data-row-key^="' + SESSION_PREFIX + '"]')
    if (row === null) {
      targetId = ''
      targetTitle = ''
      return
    }
    rememberRow(row)
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

  // A right click on the row opens the same menu through the row's own
  // handler, without ever touching the `…` button. Nothing here opens or
  // blocks the menu — it only records which Session it belongs to, which is
  // what the entry needs when the menu mounts a tick later. A right click
  // outside every row clears the target, so a menu opened elsewhere can never
  // inherit a stale one.
  document.addEventListener(
    'contextmenu',
    (event) => {
      if (!(event.target instanceof Element)) return
      const row = event.target.closest('[data-row-key^="' + SESSION_PREFIX + '"]')
      if (row === null) {
        targetId = ''
        targetTitle = ''
        return
      }
      rememberRow(row)
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

  /**
   * Take the row out of the list as soon as the host confirms the delete.
   *
   * The host restarts dsh afterwards, which reloads this page a few seconds
   * later; until then the row would sit there looking untouched, so the click
   * would feel ignored. Hiding it keeps the feedback immediate without
   * pretending the work is done — the reload is what makes it durable.
   *
   * @param {string} id - Session id whose row should disappear.
   */
  function hideRow(id) {
    for (const row of document.querySelectorAll('[data-row-key="' + SESSION_PREFIX + id + '"]')) {
      row.style.display = 'none'
    }
  }

  /** Hand one confirmed delete to the host, then drop the row from the list. */
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
      if (outcome?.deleted === true) {
        hideRow(id)
        // The host restarts the runtime after answering, and that restart
        // reloads this page; a host that cannot restart says so, and then a
        // plain reload is the only way the stale row stays gone.
        if (outcome.restarting !== true && outcome.reloaded !== true) window.location.reload()
      } else if (outcome?.reason !== 'cancelled') {
        console.warn('portable: delete skipped:', outcome?.reason)
      }
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
