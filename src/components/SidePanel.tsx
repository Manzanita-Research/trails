import { useEffect, useRef, type ReactNode, type RefObject } from "react"

export interface SidePanelProps {
  id: string
  title: string
  open: boolean
  onClose: () => void
  fallbackFocusRef?: RefObject<HTMLElement | null>
  children: ReactNode
}

export function SidePanel({ id, title, open, onClose, fallbackFocusRef, children }: SidePanelProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const titleId = `${id}-title`

  useEffect(() => {
    if (!open) return

    const dialog = dialogRef.current
    if (!dialog) return

    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow

    if (!dialog.open) dialog.showModal()
    document.body.style.overflow = "hidden"
    closeRef.current?.focus()

    return () => {
      if (dialog.open) dialog.close()
      document.body.style.overflow = previousOverflow

      const opener = openerRef.current
      if (opener?.isConnected) opener.focus()
      else fallbackFocusRef?.current?.focus()
      openerRef.current = null
    }
  }, [fallbackFocusRef, open])

  return (
    <dialog
      ref={dialogRef}
      id={id}
      className="side-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="side-panel-sheet">
        <div className="side-panel-head">
          <h2 id={titleId}>{title}</h2>
          <button ref={closeRef} type="button" className="close-btn" aria-label={`close ${title}`} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="side-panel-body">{children}</div>
      </div>
    </dialog>
  )
}
