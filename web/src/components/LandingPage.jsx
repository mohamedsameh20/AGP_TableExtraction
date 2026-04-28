import { useState, useCallback } from 'react'
import { LandingAnimation, FedoraSVG } from './LandingAnimation'

export default function LandingPage({ onDismiss }) {
  const [fadingOut, setFadingOut] = useState(false)

  const handleDismiss = useCallback(() => {
    setFadingOut(true)
    // Wait for fade-out transition, then notify parent
    setTimeout(() => {
      onDismiss()
    }, 600)
  }, [onDismiss])

  const handleAnimationComplete = useCallback(() => {
    // Auto-dismiss after a short delay once animation finishes
    const timer = setTimeout(handleDismiss, 1200)
    return () => clearTimeout(timer)
  }, [handleDismiss])

  return (
    <div
      className={`fixed inset-0 z-50 transition-opacity duration-500 ${fadingOut ? 'opacity-0' : 'opacity-100'}`}
      style={{ backgroundColor: '#09090b' }}
    >
      {/* Subtle grid background */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage:
            'linear-gradient(to right, rgba(229,115,0,0.08) 1px, transparent 1px), linear-gradient(to bottom, rgba(229,115,0,0.08) 1px, transparent 1px)',
          backgroundSize: '4rem 4rem',
          maskImage: 'radial-gradient(ellipse 60% 50% at 50% 0%, #000 70%, transparent 100%)',
          WebkitMaskImage: 'radial-gradient(ellipse 60% 50% at 50% 0%, #000 70%, transparent 100%)',
        }}
      />

      {/* Navbar */}
      <nav className="relative z-10 flex items-center justify-between p-6 px-8 max-w-7xl mx-auto">
        <div className="font-bold text-xl tracking-wide flex items-center gap-3">
          <div
            className="w-12 h-12 flex items-center justify-center rounded-full border p-2"
            style={{
              backgroundColor: 'rgba(30,30,35,0.4)',
              borderColor: 'rgba(229,115,0,0.2)',
              boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
            }}
          >
            <FedoraSVG className="w-full h-full" />
          </div>
          <span className="text-orange-50 font-black tracking-tight text-2xl">Agent P-DF</span>
        </div>
        <div className="flex gap-4">
          <button
            onClick={handleDismiss}
            className="text-sm font-bold px-6 py-2.5 rounded transition-all"
            style={{
              backgroundColor: '#E57300',
              color: '#fff',
              boxShadow: '0 0 15px rgba(229,115,0,0.3)',
            }}
            onMouseEnter={(e) => {
              e.target.style.backgroundColor = '#ff8c00'
              e.target.style.boxShadow = '0 0 20px rgba(229,115,0,0.5)'
            }}
            onMouseLeave={(e) => {
              e.target.style.backgroundColor = '#E57300'
              e.target.style.boxShadow = '0 0 15px rgba(229,115,0,0.3)'
            }}
          >
            Get Started
          </button>
        </div>
      </nav>

      {/* Main Hero */}
      <main className="relative z-10 flex flex-col items-center justify-center pt-24 pb-32 px-4">
        {/* Core Animation Component */}
        <LandingAnimation onComplete={handleAnimationComplete} />

        <div className="max-w-2xl text-center mt-8 space-y-6">
          <h1
            className="text-4xl md:text-5xl font-bold"
            style={{
              backgroundClip: 'text',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundImage: 'linear-gradient(to bottom right, white, #fed7aa)',
            }}
          >
            Extract Data with Precision
          </h1>
          <p className="text-lg md:text-xl" style={{ color: '#94a3b8' }}>
            Unleash the supreme AI table extractor. Upload complex PDFs, and watch
            our intelligent agent seamlessly reconstruct them into flawless, usable
            tables.
          </p>
          <div className="pt-4 flex justify-center gap-4">
            <button
              onClick={handleDismiss}
              className="text-lg font-bold px-8 py-4 rounded transition-all"
              style={{
                backgroundColor: '#E57300',
                color: '#fff',
                boxShadow: '0 0 20px rgba(229,115,0,0.4)',
              }}
              onMouseEnter={(e) => {
                e.target.style.backgroundColor = '#ff8c00'
                e.target.style.transform = 'translateY(-2px)'
              }}
              onMouseLeave={(e) => {
                e.target.style.backgroundColor = '#E57300'
                e.target.style.transform = 'translateY(0)'
              }}
            >
              Try Table Detective Free
            </button>
          </div>
        </div>
      </main>
    </div>
  )
}
