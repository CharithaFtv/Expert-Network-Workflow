import { createProject } from "@/lib/projects";
import { currentUser } from "@/lib/session";

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ errors: { form: "Sign in to submit." } }, { status: 401 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ errors: { form: "Malformed request." } }, { status: 400 });
  }
  const result = await createProject(body, user);
  if (!result.ok) return Response.json({ errors: result.errors }, { status: 422 });
  return Response.json({ id: result.id }, { status: 201 });
}
