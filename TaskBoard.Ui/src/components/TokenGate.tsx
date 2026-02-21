import { useState } from 'react'

export function TokenGate({
  baseUrl,
  onSave,
}: {
  baseUrl: string
  onSave: (token: string, baseUrl: string) => void
}) {
  const [tokenInput, setTokenInput] = useState('')
  const [baseInput, setBaseInput] = useState(baseUrl)

  return (
    <div className="token-gate">
      <h1>TaskBoard</h1>
      <p>Enter your API bearer token to connect.</p>
      <label>
        Token
        <input
          type="password"
          autoFocus
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && tokenInput.trim()) {
              onSave(tokenInput.trim(), baseInput.trim())
            }
          }}
        />
      </label>
      <label>
        API Base URL <span className="field-hint">(optional)</span>
        <input
          value={baseInput}
          placeholder="http://localhost:5005"
          onChange={(e) => setBaseInput(e.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={!tokenInput.trim()}
        onClick={() => onSave(tokenInput.trim(), baseInput.trim())}
      >
        Connect
      </button>
    </div>
  )
}
