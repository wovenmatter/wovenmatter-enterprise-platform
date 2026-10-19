import { Link } from "react-router-dom";

export function Brand({ to = "/" }: { to?: string }) {
  return (
    <Link to={to} className="brand">
      <img src="/enterprise/app-icon-128.png" alt="" width={24} height={24} />
      <span>WovenMatter Enterprise Platform</span>
    </Link>
  );
}
