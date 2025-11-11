import './App.css'
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from '@/components/ui/carousel'

function App() {
  return (
    <div
      className="min-h-screen flex flex-col"
      style={{
        backgroundColor: '#F5F5F5'
      }}
    >
      {/* Header */}
      <header className="w-full py-8 px-6">
        <div className="max-w-5xl mx-auto text-center">
          <h1
            style={{
              fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", system-ui, sans-serif',
              fontWeight: 500,
              fontSize: '20px',
              color: '#191919',
              letterSpacing: '-0.03em'
            }}
          >
            .octave
          </h1>
        </div>
      </header>

      {/* Hero Image Carousel - Full Width */}
      <div className="w-full px-6 mb-16">
        <div className="max-w-5xl mx-auto">
          <Carousel
            opts={{
              align: "start",
              loop: true,
            }}
            className="w-full"
          >
            <CarouselContent>
              <CarouselItem>
                <img
                  src="/1.png"
                  alt="Octave IDE Interface - Code Editor View"
                  className="w-full h-[500px] object-cover rounded-2xl border border-[#d0d0d0]"
                />
              </CarouselItem>
              <CarouselItem>
                <img
                  src="/2.png"
                  alt="Octave IDE Interface - Task Management View"
                  className="w-full h-[500px] object-cover rounded-2xl border border-[#d0d0d0]"
                />
              </CarouselItem>
            </CarouselContent>
            <CarouselPrevious className="left-4" />
            <CarouselNext className="right-4" />
          </Carousel>
        </div>
      </div>

      {/* Main Content - Two Column Layout Below Image */}
      <main className="flex-1 px-6 pb-20">
        <div className="max-w-5xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-16">
          {/* Left Column - Product & CTA */}
          <div className="flex flex-col">
            {/* Title */}
            <h2
              className="mb-4 animate-title"
              style={{
                fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", system-ui, sans-serif',
                fontWeight: 500,
                fontSize: '48px',
                letterSpacing: '-0.02em',
                color: '#191919',
                lineHeight: '1.1'
              }}
            >
              Build faster with
              <br />
              Orchestrated AI agents
            </h2>

            {/* Subtitle */}
            <p
              className="animate-subtitle"
              style={{
                fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", system-ui, sans-serif',
                fontWeight: 400,
                fontSize: '18px',
                letterSpacing: '-0.01em',
                color: '#666666',
                lineHeight: '1.5'
              }}
            >
              Collaborate with multiple agents, all perfectly under control.
            </p>
          </div>

          {/* Right Column - Founder's Message */}
          <div className="flex flex-col justify-start">
            <div className="space-y-6">
              <p
                style={{
                  fontFamily: '"SF Pro Display", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
                  fontWeight: 400,
                  fontSize: '15px',
                  letterSpacing: '-0.02em',
                  color: '#191919',
                  lineHeight: '1.4'
                }}
              >
                Octave is a <span style={{
                  background: 'linear-gradient(120deg, rgba(255, 234, 0, 0.4) 0%, rgba(255, 180, 0, 0.4) 100%)',
                  backgroundPosition: '0 80%',
                  backgroundRepeat: 'no-repeat',
                  backgroundSize: '100% 50%',
                  padding: '0 3px',
                  fontWeight: 500,
                  position: 'relative'
                }}>development tool for non-developers</span>.<br />I'm building it because traditional IDEs can't deliver the productivity<br />we need anymore.
              </p>

              <p
                style={{
                  fontFamily: '"SF Pro Display", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
                  fontWeight: 400,
                  fontSize: '15px',
                  letterSpacing: '-0.02em',
                  color: '#191919',
                  lineHeight: '1.4'
                }}
              >
                What matters now isn't solving specific problems with code editors<br />—it's <span style={{
                  position: 'relative',
                  fontWeight: 500,
                  display: 'inline-block',
                  paddingBottom: '8px'
                }}>
                  structuring your vision
                  <svg
                    style={{
                      position: 'absolute',
                      left: '-2px',
                      bottom: '0',
                      width: 'calc(100% + 4px)',
                      height: '10px',
                      overflow: 'visible'
                    }}
                    viewBox="0 0 200 10"
                    preserveAspectRatio="none"
                  >
                    <path
                      d="M2,5 Q12,6 22,5 T42,5 T62,6 T82,5 T102,6 T122,5 T142,6 T162,5 T182,6 T200,5"
                      stroke="#FF9800"
                      strokeWidth="2"
                      fill="none"
                      strokeLinecap="round"
                      opacity="0.8"
                    />
                  </svg>
                </span> at a macro level and letting AI <span style={{
                  background: 'linear-gradient(120deg, rgba(16, 185, 129, 0.4) 0%, rgba(59, 130, 246, 0.4) 100%)',
                  backgroundPosition: '0 80%',
                  backgroundRepeat: 'no-repeat',
                  backgroundSize: '100% 50%',
                  padding: '0 3px',
                  fontWeight: 500,
                  borderRadius: '2px'
                }}>turn it into reality</span>.
              </p>

              <p
                style={{
                  fontFamily: '"SF Pro Display", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
                  fontWeight: 400,
                  fontSize: '15px',
                  letterSpacing: '-0.02em',
                  color: '#191919',
                  lineHeight: '1.4'
                }}
              >
                I want non-developers to freely enter the market and build products.
              </p>

              <p
                style={{
                  fontFamily: '"SF Pro Display", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
                  fontWeight: 400,
                  fontSize: '15px',
                  letterSpacing: '-0.02em',
                  color: '#666666',
                  lineHeight: '1.4',
                  fontStyle: 'normal'
                }}
              >
                William Jung
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}

export default App
