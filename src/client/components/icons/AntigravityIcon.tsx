import { type SVGProps, useId } from "react";

// Official Google Antigravity brand mark — a distinct upward "arch"/A glyph (evoking
// lift / weightlessness), NOT the Gemini four-pointed spark. Solid blue base (#3186FF) with
// Google's multicolor (yellow/red/green/blue) soft blurred glows clipped to the glyph via an
// alpha mask. Reproduced from the official logo SVG (antigravity.google press asset). Brand
// colors are literal hex (sanctioned exception to the no-hardcoded-hex rule; they don't flip
// with our theme). Mask/filter IDs are scoped via `useId()` because the icon renders more than
// once at a time (e.g. selector tile) and duplicate SVG element IDs cross-wire references.
// Identifies the Antigravity (ex-Gemini) CLI option in the MCP client selector.
const GLYPH_PATH =
  "M89.6992 93.695C94.3659 97.195 101.366 94.8617 94.9492 88.445C75.6992 69.7783 79.7825 18.445 55.8659 18.445C31.9492 18.445 36.0325 69.7783 16.7825 88.445C9.78251 95.445 17.3658 97.195 22.0325 93.695C40.1159 81.445 38.9492 59.8617 55.8659 59.8617C72.7825 59.8617 71.6159 81.445 89.6992 93.695Z";

export function AntigravityIcon(props: SVGProps<SVGSVGElement>) {
  const id = useId();
  const maskId = `${id}-mask`;
  const f = (n: number) => `${id}-f${n}`;
  return (
    <svg
      viewBox="9 17 93 81"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...props}
    >
      <path d={GLYPH_PATH} fill="#3186FF" />
      <mask
        id={maskId}
        maskUnits="userSpaceOnUse"
        x="13"
        y="18"
        width="85"
        height="78"
        style={{ maskType: "alpha" }}
      >
        <path d={GLYPH_PATH} fill="black" />
      </mask>
      <g mask={`url(#${maskId})`}>
        <g filter={`url(#${f(0)})`}>
          <ellipse
            cx="22.7873"
            cy="26.8098"
            rx="22.7873"
            ry="26.8098"
            transform="matrix(-0.112784 0.99362 -0.99362 -0.112781 66.2473 -15.5344)"
            fill="#FFE432"
          />
        </g>
        <g filter={`url(#${f(1)})`}>
          <ellipse
            cx="96.491"
            cy="35.1231"
            rx="29.5007"
            ry="30.1492"
            transform="rotate(76.9243 96.491 35.1231)"
            fill="#FC413D"
          />
        </g>
        <g filter={`url(#${f(2)})`}>
          <ellipse
            cx="9.02988"
            cy="41.6647"
            rx="30.832"
            ry="39.9417"
            transform="rotate(74.1257 9.02988 41.6647)"
            fill="#00B95C"
          />
        </g>
        <g filter={`url(#${f(4)})`}>
          <ellipse
            cx="11.2212"
            cy="42.8915"
            rx="30.22"
            ry="33.2695"
            transform="rotate(45.6065 11.2212 42.8915)"
            fill="#00B95C"
          />
        </g>
        <g filter={`url(#${f(5)})`}>
          <ellipse
            cx="75.7546"
            cy="104.822"
            rx="29.0177"
            ry="27.943"
            transform="rotate(76.9243 75.7546 104.822)"
            fill="#3186FF"
          />
        </g>
        <g filter={`url(#${f(6)})`}>
          <ellipse
            cx="33.5661"
            cy="35.4043"
            rx="33.5661"
            ry="35.4043"
            transform="matrix(-0.409539 0.912293 -0.912294 -0.409537 101.25 -15.1674)"
            fill="#FBBC04"
          />
        </g>
        <g filter={`url(#${f(7)})`}>
          <path
            d="M2.56802 149.695C-15.8116 142.48 15.5987 83.1163 23.4093 63.2203C31.22 43.3244 52.4514 33.0447 70.831 40.26C89.2107 47.4753 110.996 87.2162 103.185 107.112C95.3742 127.008 20.9477 156.91 2.56802 149.695Z"
            fill="#3186FF"
          />
        </g>
        <g filter={`url(#${f(8)})`}>
          <path
            d="M113.934 75.8079C109.013 81.5509 96.1724 78.6224 85.253 69.2667C74.3335 59.911 69.4704 47.6711 74.391 41.928C79.3116 36.185 92.1525 39.1136 103.072 48.4692C113.991 57.8249 118.855 70.0648 113.934 75.8079Z"
            fill="#749BFF"
          />
        </g>
        <g filter={`url(#${f(9)})`}>
          <ellipse
            cx="92.611"
            cy="23.7962"
            rx="44.2411"
            ry="27.5016"
            transform="rotate(34.0763 92.611 23.7962)"
            fill="#FC413D"
          />
        </g>
        <g filter={`url(#${f(10)})`}>
          <ellipse
            cx="23.4949"
            cy="29.5887"
            rx="23.7071"
            ry="13.7869"
            transform="rotate(112.516 23.4949 29.5887)"
            fill="#FFEE48"
          />
        </g>
      </g>
      <defs>
        <filter
          id={f(0)}
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feGaussianBlur stdDeviation="3.89034" />
        </filter>
        <filter
          id={f(1)}
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feGaussianBlur stdDeviation="18.8078" />
        </filter>
        <filter
          id={f(2)}
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feGaussianBlur stdDeviation="15.9884" />
        </filter>
        <filter
          id={f(4)}
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feGaussianBlur stdDeviation="15.9884" />
        </filter>
        <filter
          id={f(5)}
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feGaussianBlur stdDeviation="15.1937" />
        </filter>
        <filter
          id={f(6)}
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feGaussianBlur stdDeviation="13.7698" />
        </filter>
        <filter
          id={f(7)}
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feGaussianBlur stdDeviation="12.297" />
        </filter>
        <filter
          id={f(8)}
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feGaussianBlur stdDeviation="11.0036" />
        </filter>
        <filter
          id={f(9)}
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feGaussianBlur stdDeviation="9.29385" />
        </filter>
        <filter
          id={f(10)}
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feGaussianBlur stdDeviation="11.5027" />
        </filter>
      </defs>
    </svg>
  );
}
