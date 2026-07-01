import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'

/** Labelled form field with inline help + error, wired for accessibility.
 * Clones its single input/select child to inject `id`, `aria-invalid`, and an
 * `aria-describedby` that links the help and error text. */
export default function Field({
  id,
  label,
  help,
  error,
  required,
  children,
}: {
  id: string
  label: ReactNode
  help?: ReactNode
  error?: ReactNode
  required?: boolean
  children: ReactNode
}) {
  const helpId = help ? `${id}-help` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [helpId, errorId].filter(Boolean).join(' ') || undefined

  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': describedBy,
      })
    : children

  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      {control}
      {help && !error && (
        <div className="field-help" id={helpId}>
          {help}
        </div>
      )}
      {error && (
        <div className="field-error" id={errorId} role="alert">
          <span aria-hidden="true">⚠</span>
          {error}
        </div>
      )}
    </div>
  )
}
