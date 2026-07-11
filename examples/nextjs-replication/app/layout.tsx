import { Providers } from './providers';

export const metadata = {
  title: 'TalaDB — scoped replication hooks',
  description:
    'useQuery / useQueries / useMutation / prefetch over a seeded dummy origin, backed by the local replica.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'system-ui',
          maxWidth: 720,
          margin: '2rem auto',
          padding: '0 1rem',
          lineHeight: 1.5,
        }}
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
