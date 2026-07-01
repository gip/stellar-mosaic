import { useEffect, useRef, useState } from 'react'

/** Long-running action feedback: current step text, an indeterminate bar, and an elapsed
 * timer. Drop in while `running` is true; pass the latest status string as `step`. */
export default function ProgressSteps({
  running,
  step,
  hint = 'In-browser proving — this can take ~10–30s.',
}: {
  running: boolean
  step: string | null
  hint?: string
}) {
  const startRef = useRef<number | null>(null)
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!running) {
      startRef.current = null
      return
    }
    startRef.current = Date.now()
    const update = () => {
      const start = startRef.current
      if (start != null) setElapsed(Math.floor((Date.now() - start) / 1000))
    }
    // update() from timer callbacks (not the effect body) keeps the lint rule happy; the 0ms
    // timeout resets the display to 0 at the start of each run.
    const reset = setTimeout(update, 0)
    const iv = setInterval(update, 250)
    return () => {
      clearTimeout(reset)
      clearInterval(iv)
    }
  }, [running])

  if (!running) return null
  return (
    <div className="progress" role="status" aria-live="polite">
      <div className="progress-head">
        <span className="progress-step">{step ?? 'Working…'}</span>
        <span className="progress-elapsed">{elapsed}s</span>
      </div>
      <div className="progress-bar indeterminate" />
      {hint && <span className="progress-hint">{hint}</span>}
    </div>
  )
}
