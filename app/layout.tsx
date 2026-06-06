import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Q kangber 工具箱',
  robots: { index: false, follow: false },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-TW">
      <body className="min-h-screen">{children}</body>
    </html>
  )
}
