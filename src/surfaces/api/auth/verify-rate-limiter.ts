import { assertEqual } from "@/lib/verification/harness";
import { FixedWindowLimiter } from "@/surfaces/api/auth/rate-limiter";

function verifyRateLimiter(): void {
  verifyPerClientCapAndReset();
  verifyGlobalCapAndReset();
  console.log("rate limiter verification passed");
}

function verifyPerClientCapAndReset(): void {
  // A generous global cap so this test isolates the per-client cap of 2.
  const limiter = new FixedWindowLimiter(1_000, 2, 100);
  assertEqual(limiter.tryConsume("a", 0), true, "client first request allowed");
  assertEqual(
    limiter.tryConsume("a", 0),
    true,
    "client second request allowed",
  );
  assertEqual(
    limiter.tryConsume("a", 0),
    false,
    "client third request over the cap is blocked",
  );
  assertEqual(
    limiter.tryConsume("b", 0),
    true,
    "a different client is unaffected by another's cap",
  );
  assertEqual(
    limiter.tryConsume("a", 1_000),
    true,
    "the client window resets once it expires",
  );
  console.log("ok per-client cap blocks excess and resets after the window");
}

function verifyGlobalCapAndReset(): void {
  // A generous per-client cap so this test isolates the global cap of 2.
  const limiter = new FixedWindowLimiter(1_000, 100, 2);
  assertEqual(limiter.tryConsume("a", 0), true, "global first request allowed");
  assertEqual(
    limiter.tryConsume("b", 0),
    true,
    "global second request allowed",
  );
  assertEqual(
    limiter.tryConsume("c", 0),
    false,
    "global cap blocks a fresh client once the total is reached",
  );
  assertEqual(
    limiter.tryConsume("c", 1_000),
    true,
    "the global window resets once it expires",
  );
  console.log("ok global cap blocks excess and resets after the window");
}

verifyRateLimiter();
