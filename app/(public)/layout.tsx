/**
 * Layout for the public marketing surface (closedmesh.com). Each page in
 * this group renders its own header — there's enough variation between the
 * chat-first homepage and the long-form /about that a single shared shell
 * was more friction than it was worth. We just pass children through here
 * so the route group is well-formed and the root layout owns global chrome.
 */
export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
