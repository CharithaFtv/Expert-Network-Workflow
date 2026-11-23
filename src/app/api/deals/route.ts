import { searchDeals } from "@/lib/dealcloud";
import { currentUser } from "@/lib/session";

export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const q = new URL(req.url).searchParams.get("q") ?? "";
  return Response.json(searchDeals(q, user.id));
}
