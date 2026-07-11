import { Providers } from './providers';

export const metadata = {
  title: 'TalaDB — local-first Next.js with sync',
  description: 'Local-first notes: reads/writes hit on-device TalaDB (OPFS), a background loop syncs to /api/sync.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui', maxWidth: 640, margin: '2rem auto', padding: '0 1rem' }}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
