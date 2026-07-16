export default function Home() {
  return (
    <div className="p-4 md:p-8">
      <div className="mx-auto max-w-2xl space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">
          Pick up where you left off.
        </h1>
        <p className="text-sm text-muted-foreground">
          Choose a note in the sidebar, or right-click a folder to start a new
          one.
        </p>
      </div>
    </div>
  );
}
