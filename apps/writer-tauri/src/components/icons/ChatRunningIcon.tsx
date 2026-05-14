// Dot-matrix loader rendered in tabs / sidebar nodes while a chat run
// is in flight for the doc. Pattern is a clockwise sweep around the
// outer ring of a 5x5 grid — the inner 3x3 stays dim. Both fills are
// `currentColor` so the icon inherits the surrounding text color and
// matches IconFileDescription in muted vs. active tab states without
// a separate stylesheet.
//
// Source: hand-designed pattern from icons.icantcode.fyi
// (icantcodefyi/dot-matrix-animations). Single SVG, ~4 KB, no JS
// runtime — the browser animates `opacity` natively at 60 fps and the
// `prefers-reduced-motion` block freezes the sweep into a static dim
// ring for users who opt out of motion.

interface Props {
  size?: number
  className?: string
}

export function ChatRunningIcon({ size = 14, className }: Props) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 56 56"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label="AI is working on this document"
    >
      <title>AI is working on this document</title>
      <defs>
        <circle id="crb" r="2.4" fill="currentColor" opacity="0.07" />
        <circle id="crl" r="4.5" />
      </defs>
      <style>{`
        .crl{fill:currentColor;opacity:0;animation:cri-k 2000ms linear infinite both;}
        @keyframes cri-k{0%{opacity:0;}4%{opacity:1;}26%{opacity:0.08;}100%{opacity:0;}}
        @media (prefers-reduced-motion:reduce){.crl{animation:none;opacity:0.45;}}
        .crd00{animation-delay:0ms;}.crd01{animation-delay:125ms;}
        .crd02{animation-delay:250ms;}.crd03{animation-delay:375ms;}
        .crd04{animation-delay:500ms;}.crd10{animation-delay:1875ms;}
        .crd14{animation-delay:625ms;}.crd20{animation-delay:1750ms;}
        .crd24{animation-delay:750ms;}.crd30{animation-delay:1625ms;}
        .crd34{animation-delay:875ms;}.crd40{animation-delay:1500ms;}
        .crd41{animation-delay:1375ms;}.crd42{animation-delay:1250ms;}
        .crd43{animation-delay:1125ms;}.crd44{animation-delay:1000ms;}
      `}</style>
      {[6, 17, 28, 39, 50].flatMap((y) =>
        [6, 17, 28, 39, 50].map((x) => (
          <use key={`b-${x}-${y}`} href="#crb" x={x} y={y} />
        )),
      )}
      <use className="crl crd00" href="#crl" x="6" y="6" />
      <use className="crl crd01" href="#crl" x="17" y="6" />
      <use className="crl crd02" href="#crl" x="28" y="6" />
      <use className="crl crd03" href="#crl" x="39" y="6" />
      <use className="crl crd04" href="#crl" x="50" y="6" />
      <use className="crl crd10" href="#crl" x="6" y="17" />
      <use className="crl crd14" href="#crl" x="50" y="17" />
      <use className="crl crd20" href="#crl" x="6" y="28" />
      <use className="crl crd24" href="#crl" x="50" y="28" />
      <use className="crl crd30" href="#crl" x="6" y="39" />
      <use className="crl crd34" href="#crl" x="50" y="39" />
      <use className="crl crd40" href="#crl" x="6" y="50" />
      <use className="crl crd41" href="#crl" x="17" y="50" />
      <use className="crl crd42" href="#crl" x="28" y="50" />
      <use className="crl crd43" href="#crl" x="39" y="50" />
      <use className="crl crd44" href="#crl" x="50" y="50" />
    </svg>
  )
}
