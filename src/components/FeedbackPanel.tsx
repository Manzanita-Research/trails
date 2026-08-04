import { useEffect, useRef, useState, type RefObject } from "react"
import { FeedbackSubmissionV1Schema, encodeExact, type FeedbackSubmissionV1 } from "../../shared/protocol"
import {
  FeedbackRateLimitError,
  FeedbackSubmissionError,
  buildFeedbackSafeContext,
  submitFeedback,
  type FeedbackSafeContextInput,
} from "../lib/feedback"
import { SidePanel } from "./SidePanel"

type FeedbackKind = FeedbackSubmissionV1["kind"]
type InvalidField = "kind" | "message" | null

interface FrozenFeedback {
  readonly id: string
  readonly createdAt: string
  readonly context: FeedbackSubmissionV1["context"]
  readonly serializedPayload: string
}

export interface FeedbackPanelProps {
  readonly id: string
  readonly open: boolean
  readonly onClose: () => void
  readonly fallbackFocusRef?: RefObject<HTMLElement | null>
  readonly endpoint: string
  readonly contextInput: FeedbackSafeContextInput
}

export function FeedbackPanel({
  id,
  open,
  onClose,
  fallbackFocusRef,
  endpoint,
  contextInput,
}: FeedbackPanelProps) {
  const [kind, setKind] = useState<"" | FeedbackKind>("")
  const [message, setMessage] = useState("")
  const [followUp, setFollowUp] = useState("")
  const [includeContext, setIncludeContext] = useState(false)
  const [preview, setPreview] = useState<FrozenFeedback | null>(null)
  const [sending, setSending] = useState(false)
  const [alert, setAlert] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [invalidField, setInvalidField] = useState<InvalidField>(null)
  const kindRef = useRef<HTMLSelectElement>(null)
  const messageRef = useRef<HTMLTextAreaElement>(null)
  const previewHeadingRef = useRef<HTMLHeadingElement>(null)
  const payloadRef = useRef<HTMLElement>(null)
  const payloadContainerRef = useRef<HTMLPreElement>(null)
  const privacyId = `${id}-privacy`

  useEffect(() => {
    if (preview !== null) previewHeadingRef.current?.focus()
  }, [preview])

  const invalidatePreview = () => {
    setPreview(null)
    setAlert(null)
    setStatus(null)
    setInvalidField(null)
  }

  const preparePreview = () => {
    if (kind === "") {
      setInvalidField("kind")
      setAlert("Choose what kind of mark this is.")
      kindRef.current?.focus()
      return
    }

    const trimmedMessage = message.trim()
    if (trimmedMessage.length === 0) {
      setInvalidField("message")
      setAlert("Say what happened before previewing.")
      messageRef.current?.focus()
      return
    }

    const trimmedFollowUp = followUp.trim()
    const context = includeContext ? buildFeedbackSafeContext(contextInput) : null
    const submission: FeedbackSubmissionV1 = {
      protocolVersion: 1,
      id: crypto.randomUUID(),
      kind,
      message: trimmedMessage,
      followUp: trimmedFollowUp.length === 0 ? null : trimmedFollowUp,
      createdAt: new Date().toISOString(),
      context,
    }

    try {
      const serializedPayload = JSON.stringify(encodeExact(FeedbackSubmissionV1Schema, submission))
      setInvalidField(null)
      setAlert(null)
      setStatus(null)
      setPreview({ id: submission.id, createdAt: submission.createdAt, context, serializedPayload })
    } catch {
      setAlert("Feedback couldn’t be previewed.")
    }
  }

  const send = async () => {
    if (preview === null || sending) return
    const frozen = preview
    setSending(true)
    setAlert(null)
    setStatus("sending…")
    try {
      const receipt = await submitFeedback(endpoint, frozen.serializedPayload)
      if (receipt.id !== frozen.id) throw new FeedbackSubmissionError(502)
      setKind("")
      setMessage("")
      setFollowUp("")
      setIncludeContext(false)
      setPreview(null)
      setInvalidField(null)
      setStatus("trail marked — thank you")
    } catch (cause) {
      setStatus(null)
      setAlert(
        cause instanceof FeedbackRateLimitError
          ? "Too many marks right now — try again in 60 seconds."
          : "Feedback didn’t leave this Mac.",
      )
    } finally {
      setSending(false)
    }
  }

  const copy = async () => {
    if (preview === null || sending) return
    try {
      await navigator.clipboard.writeText(preview.serializedPayload)
      setAlert(null)
      setStatus("feedback copied.")
    } catch {
      payloadContainerRef.current?.focus()
      const selection = window.getSelection()
      const payload = payloadRef.current
      if (selection !== null && payload !== null) {
        const range = document.createRange()
        range.selectNodeContents(payload)
        selection.removeAllRanges()
        selection.addRange(range)
      }
      setStatus(null)
      setAlert("Copy failed — select the preview text.")
    }
  }

  return (
    <SidePanel
      id={id}
      title="mark this spot"
      open={open}
      onClose={onClose}
      fallbackFocusRef={fallbackFocusRef}
    >
      <form
        className="feedback-composer"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          preparePreview()
        }}
      >
        <label>
          kind
          <select
            ref={kindRef}
            value={kind}
            required
            disabled={sending}
            aria-invalid={invalidField === "kind"}
            onChange={(event) => {
              invalidatePreview()
              setKind(event.target.value as "" | FeedbackKind)
            }}
          >
            <option value="" disabled>
              choose one…
            </option>
            <option value="confusing">this is confusing</option>
            <option value="broken">something broke</option>
            <option value="idea">I have an idea</option>
            <option value="delight">this delighted me</option>
          </select>
        </label>

        <label>
          what happened?
          <textarea
            ref={messageRef}
            value={message}
            required
            maxLength={2000}
            rows={7}
            disabled={sending}
            aria-invalid={invalidField === "message"}
            onChange={(event) => {
              invalidatePreview()
              setMessage(event.target.value)
            }}
          />
        </label>

        <label>
          follow-up details (optional)
          <textarea
            value={followUp}
            maxLength={200}
            rows={3}
            disabled={sending}
            onChange={(event) => {
              invalidatePreview()
              setFollowUp(event.target.value)
            }}
          />
        </label>

        <label className="feedback-context-choice">
          <input
            type="checkbox"
            checked={includeContext}
            disabled={sending}
            onChange={(event) => {
              invalidatePreview()
              setIncludeContext(event.target.checked)
            }}
          />
          include safe context
        </label>

        <button type="submit" disabled={sending}>
          preview feedback
        </button>
      </form>

      {preview !== null && (
        <section className="feedback-preview" aria-labelledby={`${id}-preview-title`}>
          <h3 id={`${id}-preview-title`} ref={previewHeadingRef} tabIndex={-1}>
            preview
          </h3>
          <pre ref={payloadContainerRef} role="document" aria-label="feedback request body" tabIndex={-1}>
            <code ref={payloadRef}>{preview.serializedPayload}</code>
          </pre>
          <button type="button" disabled={sending} onClick={() => void copy()}>
            copy feedback
          </button>
          <div className="feedback-send">
            <p id={privacyId}>
              Feedback expires after 90 days and is deleted by the next daily cleanup. Free text and follow-up details
              leave this Mac only when you press send.
            </p>
            <button type="button" disabled={sending} aria-describedby={privacyId} onClick={() => void send()}>
              {sending ? "sending…" : "send feedback"}
            </button>
          </div>
        </section>
      )}

      {alert !== null && <p role="alert">{alert}</p>}
      {status !== null && (
        <p role="status" aria-live="polite">
          {status}
        </p>
      )}
    </SidePanel>
  )
}
