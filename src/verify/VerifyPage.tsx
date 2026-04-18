import { useEffect, useState } from 'react'

const WORKER_URL = 'https://octave-onboarding.flowcap.workers.dev/verify'

type Status = 'loading' | 'success' | 'invalid' | 'error'

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", system-ui, sans-serif'

export default function VerifyPage() {
  const [status, setStatus] = useState<Status>('loading')

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const token = params.get('token')

    if (!token) {
      setStatus('invalid')
      return
    }

    const controller = new AbortController()

    fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: controller.signal,
    })
      .then((res) => {
        if (res.ok) {
          setStatus('success')
        } else if (res.status === 400 || res.status === 404) {
          setStatus('invalid')
        } else {
          setStatus('error')
        }
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return
        setStatus('error')
      })

    return () => controller.abort()
  }, [])

  useEffect(() => {
    const title = {
      loading: 'Verifying… · Octave',
      success: 'Email verified · Octave',
      invalid: 'Link expired · Octave',
      error: 'Something went wrong · Octave',
    }[status]
    document.title = title
  }, [status])

  const config = {
    loading: {
      title: 'Verifying your email',
      message: 'Just a moment.',
    },
    success: {
      title: 'Email verified',
      message: 'Your email is confirmed. You can close this tab and return to Octave.',
    },
    invalid: {
      title: 'Link expired',
      message: 'This verification link is invalid or has already been used.',
    },
    error: {
      title: 'Something went wrong',
      message: 'Please try again in a moment.',
    },
  }[status]

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ backgroundColor: '#F5F5F5' }}
    >
      <header className="w-full py-8 px-6">
        <div className="max-w-5xl mx-auto text-center">
          <h1
            style={{
              fontFamily: FONT_STACK,
              fontWeight: 500,
              fontSize: '20px',
              color: '#191919',
              letterSpacing: '-0.03em',
            }}
          >
            .octave
          </h1>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-6 pb-20">
        <div
          className="w-full max-w-md text-center"
          style={{ fontFamily: FONT_STACK }}
        >
          <StatusIcon status={status} />

          <h2
            style={{
              fontFamily: FONT_STACK,
              fontWeight: 500,
              fontSize: '32px',
              letterSpacing: '-0.02em',
              color: '#191919',
              lineHeight: '1.1',
              marginTop: '24px',
              marginBottom: '12px',
            }}
          >
            {config.title}
          </h2>

          <p
            style={{
              fontFamily: FONT_STACK,
              fontWeight: 400,
              fontSize: '16px',
              letterSpacing: '-0.01em',
              color: '#666666',
              lineHeight: '1.5',
            }}
          >
            {config.message}
          </p>
        </div>
      </main>
    </div>
  )
}

function StatusIcon({ status }: { status: Status }) {
  const size = 48
  const stroke = '#191919'

  if (status === 'loading') {
    return (
      <div
        aria-label="Loading"
        role="status"
        style={{
          width: size,
          height: size,
          margin: '0 auto',
          borderRadius: '50%',
          border: '2px solid rgba(25, 25, 25, 0.12)',
          borderTopColor: stroke,
          animation: 'octave-spin 0.9s linear infinite',
        }}
      >
        <style>{`@keyframes octave-spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    )
  }

  if (status === 'success') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 48 48"
        fill="none"
        style={{ margin: '0 auto', display: 'block' }}
        aria-hidden="true"
      >
        <circle cx="24" cy="24" r="22" stroke={stroke} strokeWidth="2" />
        <path
          d="M15 24.5L21.5 31L33.5 18"
          stroke={stroke}
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      style={{ margin: '0 auto', display: 'block' }}
      aria-hidden="true"
    >
      <circle cx="24" cy="24" r="22" stroke={stroke} strokeWidth="2" />
      <path
        d="M17 17L31 31M31 17L17 31"
        stroke={stroke}
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  )
}
