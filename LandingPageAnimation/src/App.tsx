/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { LandingAnimation, FedoraSVG } from "./LandingAnimation";

export default function App() {
  return (
    <div className="min-h-screen bg-[#0a1118] bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-teal-950/40 via-[#0a1118] to-[#0a1118] text-slate-200 overflow-hidden font-sans">
      
      {/* Dynamic Background subtle grid */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#14b8a611_1px,transparent_1px),linear-gradient(to_bottom,#14b8a611_1px,transparent_1px)] bg-[size:4rem_4rem] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)] pointer-events-none" />

      {/* Navbar (Mock) */}
      <nav className="relative z-10 flex items-center justify-between p-6 px-8 max-w-7xl mx-auto">
        <div className="font-bold text-xl tracking-wide flex items-center gap-3">
          <div className="w-12 h-12 flex items-center justify-center bg-teal-950/40 rounded-full border border-teal-500/20 p-2 shadow-lg shadow-teal-900/20">
            <FedoraSVG className="w-full h-full drop-shadow-md" />
          </div>
          <span className="text-teal-50 font-black tracking-tight text-2xl">Agent P-DF</span>
        </div>
        <div className="flex gap-4">
          <button className="text-sm font-bold bg-teal-500 text-teal-950 px-6 py-2.5 rounded shadow-[0_0_15px_rgba(20,184,166,0.3)] hover:bg-teal-400 hover:shadow-[0_0_20px_rgba(20,184,166,0.5)] transition-all">Get Started</button>
        </div>
      </nav>

      {/* Main Hero */}
      <main className="relative z-10 flex flex-col items-center justify-center pt-24 pb-32 px-4">
        
        {/* Core Animation Component */}
        <LandingAnimation />

        <div className="max-w-2xl text-center mt-8 space-y-6">
          <h1 className="text-4xl md:text-5xl font-bold bg-clip-text text-transparent bg-gradient-to-br from-white to-teal-200">
            Extract Data with Precision
          </h1>
          <p className="text-lg md:text-xl text-slate-400">
            Unleash the supreme AI table extractor. 
            Upload complex PDFs, and watch our intelligent agent seamlessly reconstruct them into flawless, usable tables.
          </p>
          <div className="pt-4 flex justify-center gap-4">
            <button className="text-lg font-bold bg-teal-500 text-teal-950 px-8 py-4 rounded shadow-[0_0_20px_rgba(20,184,166,0.4)] hover:bg-teal-400 hover:-translate-y-1 transition-all">
              Try Table Detective Free
            </button>
          </div>
        </div>
        
      </main>
      
    </div>
  );
}
