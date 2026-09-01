import Image from "next/image";

export function BrandLogo({
  className = "h-20 w-auto max-w-[180px]",
  priority = false,
}: {
  className?: string;
  priority?: boolean;
}) {
  return (
    <Image
      src="/image.png"
      alt="WSA Global"
      width={825}
      height={820}
      priority={priority}
      className={`${className} object-contain`}
    />
  );
}
