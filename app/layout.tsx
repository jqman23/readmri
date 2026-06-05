import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Ankle MRI Navigator',
  description: 'Patient-friendly ankle and foot MRI DICOM review, annotation, and AI explanation workspace.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
