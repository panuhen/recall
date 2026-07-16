import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function SignInPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8">
      {/* One column sized to its widest child (the button), so the logo — set to
          w-full — matches the button's width exactly. */}
      <div className="flex w-fit flex-col items-center">
        <div className="recall-logo w-1/2 sm:w-2/3 aspect-square" aria-hidden>
          {/* re:call mark: triangle outline with the base's left end cut parallel
              to the left edge (retrieval). Static, no animation; fill is
              --foreground so it reads black on light and white on dark. */}
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M12.00,0.94 L23.70,22.00 L5.45,22.00 L6.56,20.00 L20.30,20.00 L12.00,5.06 L2.59,22.00 L0.30,22.00Z"
              fill="var(--foreground)"
            />
          </svg>
        </div>

        <h1 className="-mt-2 text-5xl font-semibold tracking-tight">re:call</h1>

        <a
          href="/api/auth/signin"
          className={cn(buttonVariants({ size: "lg" }), "mt-8")}
        >
          Log in with Microsoft
        </a>
      </div>
    </main>
  );
}
