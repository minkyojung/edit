import './App.css'
import { Button } from '@/components/ui/button'

function App() {
  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: '#000000' }}>
      {/* Header */}
      <header className="w-full py-6 px-6">
        <div className="max-w-7xl mx-auto">
          {/* Empty header for now */}
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 flex flex-col items-center justify-start px-4 pt-20">
        {/* Title */}
        <h1
          className="text-center mb-4"
          style={{
            fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", system-ui, sans-serif',
            fontWeight: 500,
            fontSize: '42px',
            letterSpacing: '-0.02em',
            color: '#ffffff',
            lineHeight: '1.1'
          }}
        >
          Build faster with
          <br />
          Orchestrated AI agents
        </h1>

        {/* Subtitle */}
        <p
          className="text-center mb-6"
          style={{
            fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", system-ui, sans-serif',
            fontWeight: 400,
            fontSize: '16px',
            letterSpacing: '-0.01em',
            color: '#666666',
            maxWidth: '600px'
          }}
        >
          Collaborate with multiple agents, all perfectly under control.
        </p>

        {/* CTA Button */}
        <div className="relative mb-20">
          <div className="absolute inset-0 rounded-[10px] bg-white animate-pulse-slow opacity-75 blur-md"></div>
          <Button
            size="default"
            className="relative px-5 py-2 text-sm font-medium"
            style={{
              backgroundColor: '#ffffff',
              color: '#000000',
              borderRadius: '10px'
            }}
          >
            Join Waitlist
          </Button>
        </div>

        {/* Product Snapshot */}
        <div
          className="rounded-lg mb-20"
          style={{
            width: '100%',
            maxWidth: '1200px',
            height: '600px',
            backgroundColor: '#1a1a1a',
            border: '1px solid #333333'
          }}
        >
          {/* Image placeholder */}
        </div>
      </div>
    </div>
  )
}

export default App
