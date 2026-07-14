import type { AppProps } from "next/app";
import { JetBrains_Mono, Manrope } from "next/font/google";
import "@/styles/globals.css";
import "@/styles/poster.css";
import { ErrorBoundary, ToastProvider, cx } from "@/components/ui";

// cyrillic-ext is required: Mongolian Ө/Ү live outside the base cyrillic subset.
const manrope = Manrope({
  subsets: ["latin", "cyrillic", "cyrillic-ext"],
  variable: "--font-manrope",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin", "cyrillic", "cyrillic-ext"],
  variable: "--font-jetbrains",
  display: "swap",
});

export default function App({ Component, pageProps }: AppProps) {
  return (
    <div className={cx(manrope.variable, jetbrainsMono.variable, "font-sans")}>
      <ErrorBoundary>
        <ToastProvider>
          <Component {...pageProps} />
        </ToastProvider>
      </ErrorBoundary>
    </div>
  );
}
