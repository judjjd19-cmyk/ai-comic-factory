import { Indie_Flower, The_Girl_Next_Door } from 'next/font/google'
import localFont from 'next/font/local'

// The upstream mirror contains Type 1 font binaries incorrectly named .woff2.
// Only load files confirmed to have real WOFF/WOFF2 headers. Keep the familiar
// public font keys while falling back to a compatible bundled webfont.
export const indieflower=Indie_Flower({
  subsets:['latin'],weight:'400',variable:'--font-indieflower'
})
export const thegirlnextdoor=The_Girl_Next_Door({
  subsets:['latin'],weight:'400',variable:'--font-the-girl-next-door'
})
export const actionman=localFont({
  src:'../fonts/Action-Man/Action-Man.woff2',variable:'--font-action-man'
})
export const komika=localFont({
  src:'../fonts/Komika-Hand/Komika-Hand-Bold.woff2',variable:'--font-komika'
})
export const karantula=localFont({
  src:'../fonts/Karantula/Karantula.woff2',variable:'--font-karantula'
})
export const manoskope=localFont({
  src:'../fonts/Manoskope/MANOSKOPE-Bold.woff2',variable:'--font-manoskope'
})
export const digitalstrip=localFont({
  src:'../fonts/DigitalStripBB/DigitalStripBB_Reg.woff2',
  variable:'--font-digital-strip-bb'
})
export const cartoonist=localFont({
  src:'../fonts/Komika-Text/KOMTXT__-webfont.woff',
  variable:'--font-cartoonist-fallback'
})
export const vtc=localFont({
  src:'../fonts/Komika-Display/Komika-Display.woff',
  variable:'--font-vtc-fallback'
})

// Compatibility exports for legacy names whose upstream files are not
// valid webfonts; no invalid binary is imported into the Next.js bundle.
export const paeteround=komika
export const qarmic=actionman
export const archrival=actionman
export const toontime=cartoonist

export const fonts={
  indieflower,
  thegirlnextdoor,
  actionman,
  komika,
  karantula,
  manoskope,
  cartoonist,
  digitalstrip,
  vtc
}
export const fontList=Object.keys(fonts)
export type FontName=keyof typeof fonts
export const defaultFont:FontName='cartoonist'
export const classNames=Object.values(fonts).map(font=>font.className)
export const className=classNames.join(' ')
export type FontClass=
  | 'font-indieflower'
  | 'font-thegirlnextdoor'
  | 'font-komika'
  | 'font-actionman'
  | 'font-karantula'
  | 'font-manoskope'
  | 'font-paeteround'
  | 'font-qarmic'
  | 'font-archrival'
  | 'font-cartoonist'
  | 'font-toontime'
  | 'font-vtc'
  | 'font-digitalstrip'
