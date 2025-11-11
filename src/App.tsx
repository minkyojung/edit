import './App.css'
import { Button } from '@/components/ui/button'
import { Download } from 'lucide-react'
import MatrixBackground from '@/components/MatrixBackground'

function App() {
  return (
    <div className="dark">
      <MatrixBackground />
      <div className="min-h-screen flex items-center justify-center px-4 relative z-10">
        <div className="max-w-5xl mx-auto text-center">
          <h1 className="text-4xl md:text-5xl lg:text-6xl font-normal text-white mb-8 leading-tight">
            Build multiple agents and products in parallel. Multiply your output per hour.
          </h1>
          <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
            <Button
              size="lg"
              variant="default"
              className="bg-white text-black hover:bg-gray-100 rounded-full px-6"
            >
              <Download className="mr-2 h-4 w-4" />
              Download for macOS
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="border-white text-white hover:bg-white/10 rounded-full px-6"
            >
              Book a demo
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default App
