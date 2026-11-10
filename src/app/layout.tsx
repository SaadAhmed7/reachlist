import "./globals.css";
import type { Metadata } from "next";
import { ToastHost } from "@/components/ui/Toast";

export const metadata: Metadata = {
  title: "Number Checker",
  description: "Validate numbers on WhatsApp and Telegram",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* Two blurred blobs live on body::before/after; these add the third
            and the grain that stops wide displays banding. */}
        <div className="mesh" aria-hidden />
        <div className="grain" aria-hidden />
        <ToastHost>
          <div className="wrap">{children}</div>
        </ToastHost>
      </body>
    </html>
  );
}
