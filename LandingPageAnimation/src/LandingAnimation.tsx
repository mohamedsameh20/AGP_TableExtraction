import React, { useEffect, useRef, useState } from "react";
import { motion, useAnimate } from "motion/react";
import { twMerge } from "tailwind-merge";
import { clsx, type ClassValue } from "clsx";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const FedoraSVG = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 100 60" className={cn("w-full h-full drop-shadow-[0_8px_16px_rgba(0,0,0,0.6)]", className)} xmlns="http://www.w3.org/2000/svg">
    <path d="M 28 40 L 35 15 C 37 5, 45 5, 50 10 C 55 15, 63 5, 65 10 C 70 15, 72 30, 72 40 Z" fill="#5c4033" stroke="#2a1b14" strokeWidth="2" strokeLinejoin="round" />
    <path d="M 28 40 L 31 30 Q 52 38 69 30 L 72 40 Q 52 45 28 40 Z" fill="#111111" />
    <path d="M 4 45 C 4 45, 25 35, 50 42 C 75 48, 96 38, 96 38 C 96 38, 90 50, 50 50 C 15 50, 4 45, 4 45 Z" fill="#463025" stroke="#2a1b14" strokeWidth="2" strokeLinejoin="round"/>
  </svg>
);

// Custom Geometric SVGs
const LetterA = ({ className, ...props }: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 100 100" className={cn("inline-block w-[0.8em] h-[1em]", className)} {...props} fill="currentColor">
    <rect x="10" y="10" width="20" height="80" />
    <rect x="70" y="10" width="20" height="80" />
    <rect x="10" y="10" width="80" height="20" />
    <rect x="10" y="45" width="80" height="20" />
  </svg>
);

const LetterP = ({ className, ...props }: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 100 100" className={cn("inline-block w-[0.8em] h-[1em]", className)} {...props} fill="currentColor">
    <rect x="10" y="10" width="20" height="80" />
    <rect x="70" y="10" width="20" height="55" />
    <rect x="10" y="10" width="80" height="20" />
    <rect x="10" y="45" width="80" height="20" />
  </svg>
);

const LetterD = ({ className, ...props }: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 100 100" className={cn("inline-block w-[0.8em] h-[1em]", className)} {...props} fill="currentColor">
    <rect x="10" y="10" width="20" height="80" />
    <rect x="70" y="10" width="20" height="80" />
    <rect x="10" y="10" width="80" height="20" />
    <rect x="10" y="70" width="80" height="20" />
  </svg>
);

const LetterF = ({ className, ...props }: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 100 100" className={cn("inline-block w-[0.8em] h-[1em]", className)} {...props} fill="currentColor">
    <rect x="10" y="10" width="20" height="80" />
    <rect x="10" y="10" width="80" height="20" />
    <rect x="10" y="45" width="60" height="20" />
  </svg>
);

export function LandingAnimation() {
  const [scope, animate] = useAnimate();
  const aRef = useRef<HTMLSpanElement>(null);
  const gentRef = useRef<HTMLSpanElement>(null);
  const pRef = useRef<HTMLSpanElement>(null);
  const dRef = useRef<HTMLSpanElement>(null);
  const fRef = useRef<HTMLSpanElement>(null);

  const [phase, setPhase] = useState(0);

  useEffect(() => {
    let active = true;

    const runSeq = async () => {
      // Wait for layout/fonts to mount
      await new Promise(r => setTimeout(r, 400));
      if (!active) return;

      const fedoraNode = document.getElementById("fedora");
      const aRect = aRef.current?.getBoundingClientRect();
      const fRect = fRef.current?.getBoundingClientRect();

      if (fedoraNode && aRect && fRect) {
        const targetRightX = fRect.right - aRect.left + 20;
        const startY = fRect.height * 0.4;

        // Snap Fedora directly to the right side of Agent PDF initially
        await animate(fedoraNode, { x: targetRightX, y: startY, rotate: 10 }, { duration: 0 });
        await animate(fedoraNode, { opacity: 1 }, { duration: 0.3 });

        await new Promise(r => setTimeout(r, 400));
        if (!active) return;

        // 1. Hat Boomerang to right (fly out further)
        await animate(fedoraNode, { x: targetRightX + aRect.width * 1.5, y: startY - aRect.height * 0.2, rotate: 30 }, { duration: 0.6, ease: "easeOut" });
        
        // 2. Hat loops back to lands perfectly on 'A' Base coordinates (0, 0)
        await animate(fedoraNode, { x: 5, y: -aRect.height * 0.05, rotate: -5, scale: 0.95 }, { duration: 0.7, ease: "backOut" });
        setPhase(1); // Hat landed

        await new Promise(r => setTimeout(r, 400));
        if (!active) return;

        // 3. 'gent' collapses
        if (gentRef.current) {
          const gentWidth = gentRef.current.offsetWidth;
          gentRef.current.style.width = `${gentWidth}px`;
          await animate(gentRef.current, { width: 0, opacity: 0, paddingRight: 0, marginLeft: 0 }, { duration: 0.6, ease: "backIn" });
          gentRef.current.style.display = 'none';
        }

        // Collapse spacer
        await animate("#spacer", { width: 0 }, { duration: 0.2 });

        // 4. P, D, F merge into A
        const currentARect2 = aRef.current?.getBoundingClientRect();
        
        const mergeLetter = async (ref: React.RefObject<HTMLSpanElement | null>, delay: number) => {
          if (!ref.current || !currentARect2) return;
          const rect = ref.current.getBoundingClientRect();
          const offsetX = currentARect2.left - rect.left;
          
          animate(ref.current, { x: offsetX, opacity: 0, filter: "blur(4px)" }, { duration: 0.5, delay });
        };

        mergeLetter(pRef, 0);
        mergeLetter(dRef, 0.15);
        await mergeLetter(fRef, 0.3);

        if (!active) return;

        // 5. Center the block! We slide #text-container.
        const scopeRect = scope.current?.getBoundingClientRect();
        const finalARect = aRef.current?.getBoundingClientRect();
        if (scopeRect && finalARect) {
            const aCenterX = finalARect.left + finalARect.width / 2;
            const scopeCenterX = scopeRect.left + scopeRect.width / 2;
            const offset = scopeCenterX - aCenterX;
            await animate("#text-container", { x: offset }, { duration: 0.8, ease: "easeInOut" });
        }

        setPhase(2); // Merge & Center complete
      }
    };
    runSeq();

    return () => { active = false; };
  }, [animate]);

  return (
    <div ref={scope} className="relative select-none flex items-center justify-center min-h-[300px] w-full mt-10">
      
      <div id="text-container" className="flex items-end text-[80px] md:text-[120px] font-black leading-none tracking-tighter text-teal-50 relative">
        
        {/* The 'A' and its child Fedora! */}
        <span ref={aRef} className={cn("relative z-20 flex transition-all duration-700 ease-in-out", phase >= 2 && "text-teal-400 drop-shadow-[0_0_20px_rgba(45,212,191,0.6)] px-2")}>
          <LetterA />
          {/* The Fedora securely contained within A, initially invisible */}
          <motion.div 
            id="fedora"
            className="absolute bottom-[90%] left-[-8%] w-[1.3em] z-30 transform origin-bottom opacity-0"
          >
            <FedoraSVG />
          </motion.div>
        </span>
        
        {/* 'gent' (Standard font for contrast) */}
        <span ref={gentRef} className="relative z-10 overflow-hidden text-teal-100/90 whitespace-nowrap pl-[0.05em] origin-left pb-2 text-[60px] md:text-[90px]" style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
          gent
        </span>
        
        {/* Space */}
        <span className="w-4 md:w-6 inline-block" id="spacer"></span>
        
        {/* P, D, F */}
        <span ref={pRef} className="relative z-10 text-teal-300 flex"><LetterP /></span>
        <span ref={dRef} className="relative z-10 text-teal-200 flex"><LetterD /></span>
        <span ref={fRef} className="relative z-10 text-teal-100 flex"><LetterF /></span>

      </div>
    </div>
  );
}
