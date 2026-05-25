export const metadata = {
  title: "SpaceDonate",
  description: "Plataforma de doações para streamers",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}