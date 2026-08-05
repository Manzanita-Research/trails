export function ActivityKey() {
  return (
    <div className="activity-key" aria-label="activity key">
      <span className="activity-key-item">
        <span className="activity-key-swatch" aria-hidden="true" />
        your attention
      </span>
      <span className="activity-key-item">
        <span className="activity-key-swatch activity-key-swatch-runtime" aria-hidden="true" />
        agent runtime
      </span>
      <span className="activity-key-item">
        <span className="activity-key-swatch activity-key-swatch-meeting" aria-hidden="true" />
        meeting
      </span>
      <span className="activity-key-item">
        <span className="activity-key-swatch activity-key-swatch-image" aria-hidden="true" />
        image generation
      </span>
    </div>
  )
}
