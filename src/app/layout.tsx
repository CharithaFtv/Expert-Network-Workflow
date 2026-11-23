import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { unreadCount } from "@/lib/projects";
import { SESSION_COOKIE, currentUser } from "@/lib/session";
import "./globals.css";

export const metadata: Metadata = {
  title: "Expert Network | FTV Capital",
  description: "Expert network project workflow for FTV Capital deal teams.",
};

async function signOut() {
  "use server";
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  const unread = user ? await unreadCount(user.id) : 0;
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <Link href="/" className="brand">
            <img src="/logo-white.svg" alt="FTV Capital" />
            <span className="app-name">Expert Network</span>
          </Link>
          <nav>
            {user && (
              <>
                <Link href="/">Projects</Link>
                <Link href="/projects/new">New request</Link>
                <Link href="/notifications">
                  Notifications{unread > 0 && <span className="badge">{unread}</span>}
                </Link>
              </>
            )}
          </nav>
          {user && (
            <>
              <div className="who">
                {user.name}
                <span>{[user.title, user.team].filter(Boolean).join(" · ")}</span>
              </div>
              <form action={signOut}>
                <button className="link-btn" type="submit">
                  Sign out
                </button>
              </form>
            </>
          )}
        </header>
        {children}
      </body>
    </html>
  );
}
