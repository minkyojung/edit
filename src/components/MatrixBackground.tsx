import { useEffect, useRef } from 'react'

const MatrixBackground = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Set canvas size
    const resizeCanvas = () => {
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight
    }
    resizeCanvas()

    // Characters for the matrix effect - mix of katakana, latin, and numbers
    const characters = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%^&*()'
    const fontSize = 12
    let columns = Math.floor(canvas.width / fontSize)

    // Array to track the y position of each column
    const drops: number[] = []
    for (let i = 0; i < columns; i++) {
      drops[i] = Math.random() * -100 // Start with random positions
    }

    // Drawing function
    const draw = () => {
      // Semi-transparent black to create trailing effect
      ctx.fillStyle = 'rgba(0, 0, 0, 0.05)'
      ctx.fillRect(0, 0, canvas.width, canvas.height)

      // Green text - brighter for visibility
      ctx.fillStyle = '#0F9'
      ctx.font = fontSize + 'px monospace'

      // Loop through drops
      for (let i = 0; i < drops.length; i++) {
        // Random character
        const text = characters.charAt(Math.floor(Math.random() * characters.length))

        // Draw the character
        ctx.fillText(text, i * fontSize, drops[i] * fontSize)

        // Reset drop to top randomly after it crosses the screen
        if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) {
          drops[i] = 0
        }

        // Move the drop down
        drops[i]++
      }
    }

    // Animate the matrix
    const interval = setInterval(draw, 33) // ~30 FPS

    // Resize canvas when window is resized
    const handleResize = () => {
      resizeCanvas()

      // Recalculate columns
      const newColumns = Math.floor(canvas.width / fontSize)
      drops.length = newColumns
      for (let i = 0; i < newColumns; i++) {
        if (drops[i] === undefined) {
          drops[i] = Math.random() * -100
        }
      }
      columns = newColumns
    }

    window.addEventListener('resize', handleResize)

    return () => {
      clearInterval(interval)
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="fixed top-0 left-0 w-full h-full z-0 opacity-30"
      style={{ backgroundColor: '#000' }}
    />
  )
}

export default MatrixBackground
