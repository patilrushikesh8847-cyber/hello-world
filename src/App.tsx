import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Activity, ArrowUpRight, BedDouble, Bell, Building2, Check,
  CircleHelp, ClipboardList, CreditCard, Download, FileBarChart, FileText, LayoutDashboard,
  LogOut, Menu, Plus, Printer, Search, ShieldCheck, Users, Wallet, X,
} from "lucide-react";
import { api, downloadCsv, getToken, saveToken } from "./api";

type Role = "ADMIN" | "WARDEN" | "STUDENT";
type User = { id: string; email: string; full_name: string; role: Role };
type Row = Record<string, string | number | boolean | null | undefined>;
type Page = "Overview" | "Students" | "Rooms" | "Fees" | "Complaints" | "Notices" | "Reports";
type DialogKind = "student" | "warden" | "hostel" | "room" | "allocation" | "invoice" | "payment" | "complaint" | "notice" | "status" | "password" | "password-confirm";

const navItems: { label: Page; icon: typeof LayoutDashboard; roles: Role[] }[] = [
  { label: "Overview", icon: LayoutDashboard, roles: ["ADMIN", "WARDEN", "STUDENT"] },
  { label: "Students", icon: Users, roles: ["ADMIN", "WARDEN"] },
  { label: "Rooms", icon: BedDouble, roles: ["ADMIN", "WARDEN"] },
  { label: "Fees", icon: Wallet, roles: ["ADMIN", "WARDEN", "STUDENT"] },
  { label: "Complaints", icon: ClipboardList, roles: ["ADMIN", "WARDEN", "STUDENT"] },
  { label: "Notices", icon: Bell, roles: ["ADMIN", "WARDEN", "STUDENT"] },
  { label: "Reports", icon: FileBarChart, roles: ["ADMIN", "WARDEN"] },
];

const labels: Record<string, string> = {
  ACTIVE: "Active", INACTIVE: "Inactive", OPEN: "Open", IN_PROGRESS: "In progress",
  RESOLVED: "Resolved", CLOSED: "Closed", MAINTENANCE: "Maintenance", CLEANING: "Cleaning",
  ELECTRICAL: "Electrical", PLUMBING: "Plumbing", OTHER: "Other", CASH: "Cash",
  BANK_TRANSFER: "Bank transfer", CARD: "Card", ALL: "Everyone", STUDENTS: "Students", WARDENS: "Wardens",
};

const money = (amount: unknown) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: import.meta.env.VITE_CURRENCY || "USD", maximumFractionDigits: 0 }).format(Number(amount ?? 0));
const shortDate = (value: unknown) => {
  if (!value) return "—";
  const text = String(value);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T12:00:00`) : new Date(text);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};
const titleCase = (value: unknown) => labels[String(value)] ?? String(value ?? "—").replaceAll("_", " ");

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [page, setPage] = useState<Page>("Overview");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [students, setStudents] = useState<Row[]>([]);
  const [rooms, setRooms] = useState<Row[]>([]);
  const [hostels, setHostels] = useState<Row[]>([]);
  const [wardens, setWardens] = useState<Row[]>([]);
  const [invoices, setInvoices] = useState<Row[]>([]);
  const [payments, setPayments] = useState<Row[]>([]);
  const [complaints, setComplaints] = useState<Row[]>([]);
  const [notices, setNotices] = useState<Row[]>([]);
  const [summary, setSummary] = useState<Row | null>(null);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [selected, setSelected] = useState<Row | null>(null);

  useEffect(() => {
    if (!getToken()) return;
    api<User>("/auth/me").then(setUser).catch(() => {
      saveToken(null);
      setError("Your session could not be verified. Please sign in again.");
    });
  }, []);

  const load = useCallback(async () => {
    if (!user) return;
    setError("");
    try {
      const requests: Promise<void>[] = [api<Row>("/reports/summary").then(setSummary)];
      if (user.role !== "STUDENT")
        requests.push(api<Row[]>(`/students?search=${encodeURIComponent(page === "Students" ? query : "")}`).then(setStudents));
      if (["Rooms", "Overview"].includes(page) && user.role !== "STUDENT")
        requests.push(api<Row[]>("/rooms").then(setRooms), api<Row[]>("/hostels").then(setHostels));
      if (["Rooms", "Overview"].includes(page) && user.role === "ADMIN")
        requests.push(api<Row[]>("/wardens").then(setWardens));
      if (["Fees", "Overview"].includes(page))
        requests.push(api<Row[]>("/invoices").then(setInvoices), api<Row[]>("/payments").then(setPayments));
      if (["Complaints", "Overview"].includes(page)) requests.push(api<Row[]>("/complaints").then(setComplaints));
      if (["Notices", "Overview"].includes(page)) requests.push(api<Row[]>("/notices").then(setNotices));
      if (page === "Reports" && user.role !== "STUDENT")
        requests.push(api<Row[]>("/students").then(setStudents), api<Row[]>("/rooms").then(setRooms),
          api<Row[]>("/invoices").then(setInvoices), api<Row[]>("/payments").then(setPayments),
          api<Row[]>("/complaints").then(setComplaints));
      await Promise.all(requests);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load data");
    }
  }, [page, query, user]);

  useEffect(() => { void load(); }, [load]);

  const flash = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 3500);
  };

  async function signOut() {
    try { await api("/auth/logout", { method: "POST" }); }
    catch { setError("The local session was cleared, but the server could not revoke it. The token expires automatically."); }
    saveToken(null);
    setUser(null);
    setPage("Overview");
  }

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError("");
    const data = new FormData(event.currentTarget);
    try {
      const result = await api<{ access_token: string; user: User }>("/auth/login", {
        method: "POST", body: JSON.stringify({ email: data.get("email"), password: data.get("password") }),
      });
      saveToken(result.access_token); setUser(result.user); flash("Welcome back.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to sign in"); }
    finally { setBusy(false); }
  }

  async function handleAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dialog) return;
    setBusy(true); setError("");
    const values = Object.fromEntries([...new FormData(event.currentTarget).entries()].map(([key, value]) => [key, String(value)]));
    const send = (path: string, method: string, body: Row) => api(path, { method, body: JSON.stringify(body) });
    try {
      switch (dialog) {
        case "student": await send("/students", "POST", values); flash("Student account created."); break;
        case "warden": await send("/wardens", "POST", values); flash("Warden account created."); break;
        case "hostel": await send("/hostels", "POST", { ...values, warden_id: values.warden_id || null }); flash("Hostel created."); break;
        case "room": await send("/rooms", "POST", { ...values, floor: Number(values.floor), capacity: Number(values.capacity), monthly_fee: Number(values.monthly_fee) }); flash("Room added."); break;
        case "allocation": await send("/allocations", "POST", values); flash("Room allocation created."); break;
        case "invoice": await send("/invoices", "POST", { ...values, amount: Number(values.amount) }); flash("Invoice created."); break;
        case "payment": await send("/payments", "POST", { ...values, amount: Number(values.amount) }); flash("Payment recorded."); break;
        case "complaint": await send("/complaints", "POST", values); flash("Complaint submitted."); break;
        case "notice": await send("/notices", "POST", values); flash("Notice published."); break;
        case "status":
          if (selected?.id && selected.type === "complaint") {
            await send(`/complaints/${selected.id}`, "PATCH", values); flash("Complaint status updated.");
          } else if (selected?.id && selected.type === "student") {
            await send(`/students/${selected.id}`, "PATCH", values); flash("Student record updated.");
          }
          break;
        case "password":
          await send("/auth/password-reset", "POST", { email: values.email });
          setDialog("password-confirm"); flash("If the account exists, a reset token has been emailed."); return;
        case "password-confirm":
          await send("/auth/password-reset/confirm", "POST", { token: values.token, password: values.password });
          flash("Password updated. Sign in with your new password."); break;
          break;
      }
      setDialog(null); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Action failed"); }
    finally { setBusy(false); }
  }

  if (!user) return <Login onSubmit={submitLogin} busy={busy} error={error} notice={notice} onReset={() => setDialog("password")} dialog={dialog} onClose={() => setDialog(null)} onAction={handleAction} />;
  const visibleNav = navItems.filter((item) => item.roles.includes(user.role));
  const roleName = user.role === "ADMIN" ? "Hostel administrator" : user.role === "WARDEN" ? "Warden" : "Student";
  return (
    <div className="app-shell">
      {mobileOpen && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
      <aside className={`sidebar ${mobileOpen ? "sidebar-open" : ""}`}>
        <div className="brand-lockup"><span className="brand-icon"><Building2 size={20} /></span><span>northfield<span className="brand-sub">HOSTEL MANAGEMENT</span></span></div>
        <div className="workspace-label">WORKSPACE</div>
        <nav className="nav-list" aria-label="Main navigation">
          {visibleNav.map(({ label, icon: Icon }) => (
            <button key={label} className={`nav-link ${page === label ? "nav-active" : ""}`} onClick={() => { setPage(label); setMobileOpen(false); }}>
              <Icon size={18} strokeWidth={1.8} /><span>{label}</span>
              {label === "Complaints" && summary?.open_complaints ? <span className="nav-count">{summary.open_complaints}</span> : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="help-card"><div className="help-icon"><CircleHelp size={17} /></div><strong>Need a hand?</strong><span>Reach out to your system administrator.</span></div>
          <div className="profile-row"><div className="avatar">{user.full_name.slice(0, 1).toUpperCase()}</div><div className="profile-copy"><strong>{user.full_name}</strong><span>{roleName}</span></div><button className="icon-button" title="Sign out" onClick={signOut}><LogOut size={17} /></button></div>
        </div>
      </aside>
      <main className="main-shell">
        <header className="topbar">
          <button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><Menu size={20} /></button>
          <div className="breadcrumbs"><span>Workspace</span><span className="crumb-slash">/</span><strong>{page}</strong></div>
          <div className="topbar-actions">
            <span className="today-label">{new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</span>
            <button className="top-notification" onClick={() => setPage("Notices")} aria-label="View notices"><Bell size={18} /><i /></button>
            <div className="avatar avatar-small">{user.full_name.slice(0, 1).toUpperCase()}</div>
          </div>
        </header>
        <div className="page-content">
          {error && <div className="alert-error" role="alert"><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss"><X size={16} /></button></div>}
          {notice && <div className="toast-success" role="status"><Check size={17} />{notice}</div>}
          <div className="page-heading"><div><p className="eyebrow">{page === "Overview" ? "YOUR CAMPUS AT A GLANCE" : `${roleName.toUpperCase()} WORKSPACE`}</p><h1>{page === "Overview" ? `Good ${greeting()}, ${user.full_name.split(" ")[0]}.` : page}</h1><p className="heading-sub">{headingCopy(page, user.role)}</p></div><PageActions page={page} role={user.role} hasHostels={hostels.length > 0} open={setDialog} /></div>
          {page === "Overview" && <Overview role={user.role} summary={summary} students={students} rooms={rooms} complaints={complaints} notices={notices} invoices={invoices} open={setDialog} select={setSelected} navigate={setPage} />}
          {page === "Students" && <Students rows={students} query={query} onQuery={setQuery} open={setDialog} select={setSelected} reload={load} />}
          {page === "Rooms" && <Rooms rows={rooms} hostels={hostels} open={setDialog} />}
          {page === "Fees" && <Fees role={user.role} invoices={invoices} payments={payments} />}
          {page === "Complaints" && <Complaints rows={complaints} role={user.role} open={setDialog} select={setSelected} />}
          {page === "Notices" && <Notices rows={notices} role={user.role} />}
          {page === "Reports" && <Reports students={students} rooms={rooms} invoices={invoices} payments={payments} complaints={complaints} />}
          <footer className="page-footer"><span>Northfield Hostel Management</span><span>Live data · Secure session</span></footer>
        </div>
      </main>
      {dialog && <Dialog kind={dialog} rows={selected} hostels={hostels} wardens={wardens} rooms={rooms} students={students} invoices={invoices} error={error} notice={notice} onClose={() => { setDialog(null); setError(""); }} onSubmit={handleAction} busy={busy} />}
    </div>
  );
}

function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
}

function headingCopy(page: Page, role: Role) {
  if (role === "STUDENT") return page === "Overview" ? "Here’s what’s happening with your hostel stay." : page === "Fees" ? "Your invoices, balances and payment history." : page === "Complaints" ? "Raise an issue and follow its progress." : "Updates from your hostel community.";
  const copy: Record<Page, string> = {
    Overview: "Here’s what’s happening across your hostel today.",
    Students: "Student records and current room assignments.",
    Rooms: "Hostels, room availability and resident allocations.",
    Fees: "Invoices, outstanding balances and recorded payments.",
    Complaints: "Review and resolve student-reported issues.",
    Notices: "Share updates with your hostel community.",
    Reports: "Live operational data, ready to export or print.",
  };
  return copy[page];
}

function PageActions({ page, role, hasHostels, open }: { page: Page; role: Role; hasHostels: boolean; open: (kind: DialogKind) => void }) {
  if (page === "Students" && role === "ADMIN") return <button className="button button-primary" onClick={() => open("student")}><Plus size={16} /> Add student</button>;
  if (page === "Rooms" && role === "ADMIN") return <div className="action-pair"><button className="button button-secondary" onClick={() => open("warden")}><Plus size={15} /> Add warden</button><button className="button button-secondary" onClick={() => open("hostel")}><Plus size={15} /> Add hostel</button><button className="button button-primary" disabled={!hasHostels} title={!hasHostels ? "Create a hostel first" : undefined} onClick={() => open("room")}><Plus size={16} /> Add room</button></div>;
  if (page === "Rooms" && role === "WARDEN") return <button className="button button-primary" disabled={!hasHostels} title={!hasHostels ? "Ask an administrator to assign a hostel first" : undefined} onClick={() => open("room")}><Plus size={16} /> Add room</button>;
  if (page === "Fees" && role !== "STUDENT") return <div className="action-pair"><button className="button button-secondary" onClick={() => open("invoice")}><Plus size={15} /> New invoice</button><button className="button button-primary" onClick={() => open("payment")}><CreditCard size={16} /> Record payment</button></div>;
  if (page === "Complaints" && role === "STUDENT") return <button className="button button-primary" onClick={() => open("complaint")}><Plus size={16} /> New complaint</button>;
  if (page === "Notices" && role !== "STUDENT") return <button className="button button-primary" onClick={() => open("notice")}><Plus size={16} /> Publish notice</button>;
  if (page === "Overview" && role === "ADMIN") return <button className="button button-secondary" onClick={() => window.print()}><Printer size={16} /> Print overview</button>;
  if (page === "Reports") return <button className="button button-secondary" onClick={() => window.print()}><Printer size={16} /> Print report</button>;
  return null;
}

function Overview({ role, summary, students, rooms, complaints, notices, invoices, open, select, navigate }: {
  role: Role; summary: Row | null; students: Row[]; rooms: Row[]; complaints: Row[]; notices: Row[]; invoices: Row[];
  open: (kind: DialogKind) => void; select: (row: Row | null) => void; navigate: (page: Page) => void;
}) {
  if (role === "STUDENT") {
    const detail = (summary?.room ?? {}) as Row;
    const bills = (summary?.invoices ?? {}) as Row;
    return <><div className="student-summary"><div className="welcome-panel"><span className="welcome-icon"><BedDouble size={22} /></span><div><p className="panel-kicker">YOUR ACCOMMODATION</p><h2>{detail.room_number ? `Room ${detail.room_number}` : "No room allocated"}</h2><p>{detail.hostel_name ?? "Contact your hostel administrator for your room assignment."}</p></div><span className="occupancy-chip">{detail.check_in ? `Since ${shortDate(detail.check_in)}` : "Room details"}</span></div><div className="summary-card"><span className="stat-icon icon-amber"><Wallet size={19} /></span><span className="stat-label">Outstanding balance</span><strong>{money(bills.outstanding)}</strong><span className="stat-foot">{bills.invoices ?? 0} invoices on your account</span></div></div>
      <div className="dashboard-grid"><section className="panel"><PanelTitle title="Your recent invoices" subtitle="Stay on top of upcoming payments" action="View fees" onAction={() => navigate("Fees")} /><InvoiceTable rows={invoices.slice(0, 5)} /></section><section className="panel"><PanelTitle title="Hostel notices" subtitle="The latest updates from your community" action="All notices" onAction={() => navigate("Notices")} /><NoticeList rows={notices.slice(0, 4)} /></section></div>
      <section className="panel complaint-panel"><PanelTitle title="Your complaints" subtitle="Track the progress of your requests" action="View all" onAction={() => navigate("Complaints")} /><ComplaintTable rows={complaints.slice(0, 4)} role={role} open={open} select={select} /></section>
    </>;
  }
  const beds = Number(summary?.beds ?? 0);
  const occupied = Number(summary?.occupied ?? 0);
  const statCards = [
    { title: "Active students", value: summary?.students ?? "—", note: "Current residents", icon: Users, tint: "teal", trend: "Live count" },
    { title: "Room occupancy", value: beds ? `${Math.round(occupied / beds * 100)}%` : "—", note: `${occupied} of ${beds} beds occupied`, icon: BedDouble, tint: "blue", trend: "Live count" },
    { title: "Open complaints", value: summary?.open_complaints ?? "—", note: "Awaiting resolution", icon: ClipboardList, tint: "amber", trend: "Needs attention" },
    { title: "Outstanding fees", value: money(summary?.outstanding), note: "Remaining invoice balance", icon: Wallet, tint: "purple", trend: "Live balance" },
  ];
  return <><div className="stats-grid">{statCards.map(({ title, value, note, icon: Icon, tint, trend }) => <article className="stat-card" key={title}><div className="stat-top"><span className={`stat-icon icon-${tint}`}><Icon size={19} /></span><span className="stat-trend"><Activity size={13} /> {trend}</span></div><span className="stat-label">{title}</span><strong>{value}</strong><span className="stat-foot">{note}</span></article>)}</div>
    <div className="dashboard-grid"><section className="panel"><PanelTitle title="Recent students" subtitle="Latest resident records" action="All students" onAction={() => navigate("Students")} /><StudentTable rows={students.slice(0, 5)} compact /></section><section className="panel"><PanelTitle title="Room availability" subtitle="Current occupancy by room" action="All rooms" onAction={() => navigate("Rooms")} /><RoomTable rows={rooms.slice(0, 5)} /></section></div>
    <div className="dashboard-grid lower-grid"><section className="panel"><PanelTitle title="Needs attention" subtitle="Open student complaints" action="View all" onAction={() => navigate("Complaints")} /><ComplaintTable rows={complaints.filter((r) => r.status === "OPEN" || r.status === "IN_PROGRESS").slice(0, 4)} role={role} open={open} select={select} /></section><section className="panel"><PanelTitle title="Recent notices" subtitle="Keep your community informed" action="All notices" onAction={() => navigate("Notices")} /><NoticeList rows={notices.slice(0, 4)} /></section></div>
  </>;
}

function PanelTitle({ title, subtitle, action, onAction }: { title: string; subtitle: string; action?: string; onAction?: () => void }) {
  return <div className="panel-title"><div><h2>{title}</h2><p>{subtitle}</p></div>{action && <button className="text-button" onClick={onAction}>{action}<span>→</span></button>}</div>;
}

function Students({ rows, query, onQuery, open, select, reload }: { rows: Row[]; query: string; onQuery: (value: string) => void; open: (kind: DialogKind) => void; select: (row: Row | null) => void; reload: () => Promise<void> }) {
  return <section className="panel table-panel"><div className="table-toolbar"><div className="search-box"><Search size={16} /><input aria-label="Search students" placeholder="Search by name, email or student ID…" value={query} onChange={(e) => onQuery(e.target.value)} /></div><span className="result-count">{rows.length} students</span></div><StudentTable rows={rows} onEdit={(row) => { select({ ...row, type: "student" }); open("status"); }} onCheckout={async (row) => {
    try { await api(`/allocations/${row.allocation_id}/checkout`, { method: "POST" }); await reload(); }
    catch (reason) { window.alert(reason instanceof Error ? reason.message : "Could not check out student"); }
  }} /></section>;
}

function StudentTable({ rows, compact = false, onEdit, onCheckout }: { rows: Row[]; compact?: boolean; onEdit?: (row: Row) => void; onCheckout?: (row: Row) => void }) {
  return <div className="table-scroll"><table><thead><tr><th>STUDENT</th><th>STUDENT ID</th><th>ROOM</th><th>COURSE</th><th>STATUS</th>{!compact && <th></th>}</tr></thead><tbody>
    {rows.map((row, i) => <tr key={String(row.id ?? i)}><td><div className="person-cell"><div className="avatar table-avatar">{String(row.full_name ?? "?").slice(0, 1)}</div><div><strong>{row.full_name}</strong><span>{row.email}</span></div></div></td><td className="mono">{row.student_number}</td><td>{row.room_number ? `${row.hostel_name} · ${row.room_number}` : "Unassigned"}</td><td>{row.course || "—"}</td><td><StatusBadge status={row.status} /></td>{!compact && <td><div className="row-actions">{onEdit && <button className="row-action" onClick={() => onEdit(row)}>Edit</button>}{onCheckout && row.allocation_id && <button className="row-action" onClick={() => onCheckout(row)}>Check out</button>}</div></td>}</tr>)}
    {!rows.length && <EmptyRow columns={compact ? 5 : 6} message="No student records found" />}
  </tbody></table></div>;
}

function Rooms({ rows, hostels, open }: { rows: Row[]; hostels: Row[]; open: (kind: DialogKind) => void }) {
  return <><div className="stats-grid room-stats"><MiniStat label="Hostels" value={hostels.length} icon={Building2} /><MiniStat label="Rooms" value={rows.length} icon={BedDouble} /><MiniStat label="Available beds" value={rows.reduce((sum, r) => sum + Math.max(0, Number(r.capacity) - Number(r.occupied)), 0)} icon={Check} /><MiniStat label="Total capacity" value={rows.reduce((sum, r) => sum + Number(r.capacity), 0)} icon={Users} /></div>
    <section className="panel table-panel"><div className="panel-title"><div><h2>Rooms & availability</h2><p>Room occupancy updates when residents are assigned or checked out.</p></div>{hostels.length > 0 && <button className="button button-secondary" onClick={() => open("allocation")}><Plus size={15} /> Allocate room</button>}</div><RoomTable rows={rows} /></section>
    {hostels.length > 0 && <section className="hostel-grid">{hostels.map((hostel) => <article key={String(hostel.id)} className="hostel-card"><span className="stat-icon icon-teal"><Building2 size={18} /></span><div><strong>{hostel.name}</strong><p>{hostel.address || "No address provided"}{hostel.warden_name ? ` · Warden: ${hostel.warden_name}` : ""}</p></div><div className="hostel-numbers"><span><b>{hostel.rooms}</b> rooms</span><span><b>{hostel.occupied}/{hostel.capacity}</b> beds used</span></div></article>)}</section>}
  </>;
}

function RoomTable({ rows }: { rows: Row[] }) {
  return <div className="table-scroll"><table><thead><tr><th>HOSTEL</th><th>ROOM</th><th>FLOOR</th><th>OCCUPANCY</th><th>MONTHLY FEE</th><th>AVAILABILITY</th></tr></thead><tbody>{rows.map((row, i) => {
    const capacity = Number(row.capacity ?? 0); const occupied = Number(row.occupied ?? 0); const full = occupied >= capacity;
    return <tr key={String(row.id ?? i)}><td>{row.hostel_name ?? row.hostel}</td><td><strong>{row.room_number}</strong></td><td>{row.floor}</td><td><div className="occupancy-cell"><div className="occupancy-track"><span style={{ width: `${capacity ? Math.min(100, occupied / capacity * 100) : 0}%` }} /></div><span>{occupied}/{capacity}</span></div></td><td>{money(row.monthly_fee)}</td><td><span className={`availability ${full ? "unavailable" : ""}`}><i />{full ? "Full" : `${capacity - occupied} bed${capacity - occupied === 1 ? "" : "s"} available`}</span></td></tr>;
  })}{!rows.length && <EmptyRow columns={6} message="No rooms yet. Create a hostel and add rooms to get started." />}</tbody></table></div>;
}

function Fees({ role, invoices, payments }: { role: Role; invoices: Row[]; payments: Row[] }) {
  const outstanding = invoices.reduce((total, row) => total + Number(row.balance), 0);
  const paid = invoices.reduce((total, row) => total + Number(row.paid), 0);
  return <><div className="stats-grid"><MiniStat label="Outstanding balance" value={money(outstanding)} icon={Wallet} tint="amber" /><MiniStat label="Payments recorded" value={payments.length} icon={CreditCard} /><MiniStat label="Total collected" value={money(paid)} icon={ArrowUpRight} tint="teal" /></div>
    <section className="panel table-panel"><PanelTitle title="Invoices" subtitle={`${invoices.length} invoices · balances calculated from recorded payments`} /><InvoiceTable rows={invoices} /></section>
    <section className="panel table-panel"><PanelTitle title="Payment history" subtitle="Recorded transactions and printable receipts" /><div className="table-scroll"><table><thead><tr><th>STUDENT</th><th>DESCRIPTION</th><th>DATE</th><th>METHOD</th><th>REFERENCE</th><th>AMOUNT</th><th></th></tr></thead><tbody>{payments.map((row, i) => <tr key={String(row.id ?? i)}><td>{row.student_name ?? "You"}</td><td>{row.description}</td><td>{shortDate(row.paid_at)}</td><td>{titleCase(row.method)}</td><td className="mono">{row.reference || "—"}</td><td className="amount">{money(row.amount)}</td><td><button className="row-action" onClick={() => void printReceipt(String(row.id))}><Printer size={14} /> Receipt</button></td></tr>)}{!payments.length && <EmptyRow columns={7} message="No recorded payments yet" />}</tbody></table></div></section>
    {role === "STUDENT" && <p className="info-note"><ShieldCheck size={16} /> Payments shown here are verified records entered by hostel staff. For payment assistance, contact your administrator.</p>}
  </>;
}

async function printReceipt(id: string) {
  const win = window.open("", "_blank", "width=640,height=720");
  if (!win) { window.alert("Allow pop-ups to print a receipt"); return; }
  try {
    const receipt = await api<Row>(`/reports/receipt/${id}`);
    win.document.write(`<title>Payment receipt ${escapeHtml(String(receipt.id))}</title><style>body{font:16px Arial,sans-serif;max-width:560px;margin:48px auto;color:#152b43}h1{font-size:24px}p{padding:10px 0;border-bottom:1px solid #ddd}button{padding:10px 18px}@media print{button{display:none}}</style><h1>Northfield · Payment receipt</h1><p><b>Receipt:</b> ${escapeHtml(String(receipt.id))}</p><p><b>Student:</b> ${escapeHtml(String(receipt.full_name))} (${escapeHtml(String(receipt.student_number))})</p><p><b>Invoice:</b> ${escapeHtml(String(receipt.description))}</p><p><b>Amount received:</b> ${escapeHtml(money(receipt.amount))}</p><p><b>Method:</b> ${escapeHtml(titleCase(receipt.method))}</p><p><b>Reference:</b> ${escapeHtml(String(receipt.reference || "—"))}</p><p><b>Date:</b> ${escapeHtml(shortDate(receipt.paid_at))}</p><button onclick="window.print()">Print receipt</button>`);
    win.document.close();
  } catch (reason) { win.close(); window.alert(reason instanceof Error ? reason.message : "Could not load receipt"); }
}
function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!); }

function InvoiceTable({ rows }: { rows: Row[] }) {
  return <div className="table-scroll"><table><thead><tr><th>INVOICE</th><th>{rows.some((r) => r.student_name) ? "STUDENT" : "DUE DATE"}</th><th>AMOUNT</th><th>PAID</th><th>BALANCE</th><th>STATUS</th></tr></thead><tbody>{rows.map((row, i) => <tr key={String(row.id ?? i)}><td><strong>{row.description}</strong><span className="cell-sub mono">{String(row.id ?? "").slice(0, 8)}</span></td><td>{row.student_name ? `${row.student_name} · ${row.student_number}` : shortDate(row.due_date)}</td><td>{money(row.amount)}</td><td className="paid-amount">{money(row.paid)}</td><td className="amount">{money(row.balance)}</td><td><StatusBadge status={Number(row.balance) <= 0 ? "PAID" : "PENDING"} /></td></tr>)}{!rows.length && <EmptyRow columns={6} message="No invoices have been issued" />}</tbody></table></div>;
}

function Complaints({ rows, role, open, select }: { rows: Row[]; role: Role; open: (kind: DialogKind) => void; select: (row: Row | null) => void }) {
  return <section className="panel table-panel"><PanelTitle title={role === "STUDENT" ? "Your complaints" : "All complaints"} subtitle={role === "STUDENT" ? "Follow the status of every request you have submitted." : "Review reports and keep students up to date."} /><ComplaintTable rows={rows} role={role} open={open} select={select} /></section>;
}

function ComplaintTable({ rows, role, open, select }: { rows: Row[]; role: Role; open: (kind: DialogKind) => void; select: (row: Row | null) => void }) {
  return <div className="table-scroll"><table><thead><tr>{role !== "STUDENT" && <th>STUDENT</th>}<th>ISSUE</th><th>CATEGORY</th>{role !== "STUDENT" && <th>ROOM</th>}<th>SUBMITTED</th><th>STATUS</th>{role !== "STUDENT" && <th></th>}</tr></thead><tbody>{rows.map((row, i) => <tr key={String(row.id ?? i)}>{role !== "STUDENT" && <td><strong>{row.student_name}</strong><span className="cell-sub">{row.student_number}</span></td>}<td><strong>{row.title}</strong><span className="cell-sub description-cell">{row.description}</span></td><td>{titleCase(row.category)}</td>{role !== "STUDENT" && <td>{row.room_number ? `${row.hostel_name} · ${row.room_number}` : "—"}</td>}<td>{shortDate(row.created_at)}</td><td><StatusBadge status={row.status} /></td>{role !== "STUDENT" && <td><button className="row-action" onClick={() => { select({ ...row, type: "complaint" }); open("status"); }}>Update</button></td>}</tr>)}{!rows.length && <EmptyRow columns={role === "STUDENT" ? 4 : 7} message="No complaints to show" />}</tbody></table></div>;
}

function Notices({ rows, role }: { rows: Row[]; role: Role }) {
  return <div className="notice-feed">{rows.map((row, i) => <article className="notice-card" key={String(row.id ?? i)}><span className="notice-icon"><Bell size={18} /></span><div className="notice-body"><div className="notice-meta"><span>{titleCase(row.audience)}</span><span>·</span><span>{shortDate(row.published_at)}</span><span>·</span><span>{row.author}</span></div><h2>{row.title}</h2><p>{row.body}</p></div></article>)}{!rows.length && <EmptyState icon={Bell} title="No notices yet" message={role === "STUDENT" ? "There are no published updates right now." : "Published notices will appear here."} />}</div>;
}

function NoticeList({ rows }: { rows: Row[] }) {
  return <div className="notice-list">{rows.map((row, i) => <div className="notice-list-item" key={String(row.id ?? i)}><span className="notice-dot" /><div><strong>{row.title}</strong><span>{shortDate(row.published_at)} · {titleCase(row.audience)}</span></div></div>)}{!rows.length && <p className="empty-inline">No published notices</p>}</div>;
}

function Reports({ students, rooms, invoices, payments, complaints }: { students: Row[]; rooms: Row[]; invoices: Row[]; payments: Row[]; complaints: Row[] }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const reports = useMemo(() => [
    { key: "students", title: "Student directory", description: "Student identities, status and active room assignments.", rows: students, icon: Users },
    { key: "rooms", title: "Room occupancy", description: "Capacity, current residents, availability and rates.", rows: rooms, icon: BedDouble },
    { key: "invoices", title: "Fee balances", description: "Invoice totals, paid amounts and outstanding balances.", rows: invoices, icon: FileText },
    { key: "payments", title: "Payment records", description: "Actual recorded payments with methods and references.", rows: payments, icon: CreditCard },
    { key: "complaints", title: "Complaints", description: "Student reports and their current resolution status.", rows: complaints, icon: ClipboardList },
  ], [students, rooms, invoices, payments, complaints]);
  const filteredReports = reports.map((report) => ({
    ...report,
    rows: report.rows.filter((row) => {
      const matchesSearch = !search || Object.values(row).some((value) => String(value ?? "").toLowerCase().includes(search.toLowerCase()));
      const matchesStatus = !statusFilter || !["students", "complaints"].includes(report.key) || row.status === statusFilter;
      return matchesSearch && matchesStatus;
    }),
  }));
  return <><div className="report-filters"><div className="search-box"><Search size={16} /><input aria-label="Search reports" placeholder="Search report data…" value={search} onChange={(e) => setSearch(e.target.value)} /></div><label className="filter-control">Status<select aria-label="Filter reports by status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}><option value="">All statuses</option><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option><option value="OPEN">Open</option><option value="IN_PROGRESS">In progress</option><option value="RESOLVED">Resolved</option><option value="CLOSED">Closed</option></select></label></div>
    <div className="report-grid">{filteredReports.map(({ key, title, description, rows, icon: Icon }) => <article className="report-card" key={key}><span className="stat-icon icon-blue"><Icon size={18} /></span><h2>{title}</h2><p>{description}</p>    <div className="report-card-foot"><span>{rows.length} loaded matches</span><button className="button button-secondary button-small" onClick={() => {
      const params = new URLSearchParams({ report: key, search, status_filter: statusFilter });
      void downloadCsv(`/reports/export?${params}`).catch((e) => window.alert(e.message));
    }}><Download size={14} /> Export CSV</button></div></article>)}</div><div className="info-note"><Activity size={16} /> Card counts summarize data loaded in this view; CSV exports apply the same filters to all authorized records. Warden data is limited to assigned hostels.</div></>;
}

function MiniStat({ label, value, icon: Icon, tint = "blue" }: { label: string; value: string | number; icon: typeof Users; tint?: string }) {
  return <article className="stat-card mini-stat"><span className={`stat-icon icon-${tint}`}><Icon size={18} /></span><span className="stat-label">{label}</span><strong>{value}</strong></article>;
}

function StatusBadge({ status }: { status: unknown }) {
  const text = String(status ?? "");
  const cls = text === "ACTIVE" || text === "RESOLVED" || text === "PAID" ? "badge-green" :
    text === "IN_PROGRESS" || text === "PENDING" ? "badge-amber" :
      text === "INACTIVE" || text === "CLOSED" ? "badge-muted" : "badge-blue";
  return <span className={`status-badge ${cls}`}><i />{titleCase(text)}</span>;
}

function EmptyRow({ columns, message }: { columns: number; message: string }) {
  return <tr><td colSpan={columns} className="empty-row">{message}</td></tr>;
}
function EmptyState({ icon: Icon, title, message }: { icon: typeof Bell; title: string; message: string }) {
  return <div className="empty-state"><span><Icon size={22} /></span><h2>{title}</h2><p>{message}</p></div>;
}

type Field = { name: string; label: string; type?: string; required?: boolean; options?: { value: string; label: string }[]; defaultValue?: string };
function Dialog({ kind, rows, hostels, wardens, rooms, students, invoices, error, notice, onClose, onSubmit, busy }: {
  kind: DialogKind; rows: Row | null; hostels: Row[]; wardens: Row[]; rooms: Row[]; students: Row[]; invoices: Row[];
  error: string; notice: string; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; busy: boolean;
}) {
  const title: Record<DialogKind, string> = {
    student: "Add a student", warden: "Add a warden", hostel: "Add a hostel", room: "Add a room", allocation: "Allocate a room",
    invoice: "Create an invoice", payment: "Record a payment", complaint: "Submit a complaint",
    notice: "Publish a notice", status: rows?.type === "student" ? "Update student" : "Update complaint",
    password: "Reset your password", "password-confirm": "Choose a new password",
  };
  const fields: Record<DialogKind, Field[]> = {
    student: [
      { name: "full_name", label: "Full name", required: true }, { name: "email", label: "School email", type: "email", required: true },
      { name: "password", label: "Temporary password (12+ characters)", type: "password", required: true },
      { name: "student_number", label: "Student ID", required: true }, { name: "phone", label: "Phone" },
      { name: "course", label: "Course / program" }, { name: "guardian_name", label: "Guardian name" }, { name: "guardian_phone", label: "Guardian phone" },
    ],
    warden: [{ name: "full_name", label: "Full name", required: true }, { name: "email", label: "School email", type: "email", required: true },
      { name: "password", label: "Temporary password (12+ characters)", type: "password", required: true }],
    hostel: [{ name: "name", label: "Hostel name", required: true }, { name: "address", label: "Address" },
      { name: "warden_id", label: "Assigned warden (optional)", options: [{ value: "", label: "Unassigned" }, ...wardens.map((r) => ({ value: String(r.id), label: String(r.full_name) }))] }],
    room: [{ name: "hostel_id", label: "Hostel", required: true, options: hostels.map((r) => ({ value: String(r.id), label: String(r.name) })) },
      { name: "room_number", label: "Room number", required: true }, { name: "floor", label: "Floor", type: "number", defaultValue: "0" },
      { name: "capacity", label: "Bed capacity", type: "number", required: true }, { name: "monthly_fee", label: "Monthly fee", type: "number", defaultValue: "0" }],
    allocation: [{ name: "student_id", label: "Student", required: true, options: students.filter((s) => !s.allocation_id).map((s) => ({ value: String(s.id), label: `${s.full_name} · ${s.student_number}` })) },
      { name: "room_id", label: "Room with availability", required: true, options: rooms.filter((r) => Number(r.occupied) < Number(r.capacity)).map((r) => ({ value: String(r.id), label: `${r.hostel_name} · ${r.room_number} (${Number(r.capacity) - Number(r.occupied)} available)` })) }],
    invoice: [{ name: "student_id", label: "Student", required: true, options: students.map((s) => ({ value: String(s.id), label: `${s.full_name} · ${s.student_number}` })) },
      { name: "description", label: "Description", required: true }, { name: "amount", label: "Amount", type: "number", required: true },
      { name: "due_date", label: "Due date", type: "date", required: true }],
    payment: [{ name: "invoice_id", label: "Outstanding invoice", required: true, options: invoices.filter((i) => Number(i.balance) > 0).map((i) => ({ value: String(i.id), label: `${i.student_name ?? "Student"} · ${i.description} · ${money(i.balance)} due` })) },
      { name: "amount", label: "Amount received", type: "number", required: true }, { name: "method", label: "Payment method", required: true, options: ["CASH", "BANK_TRANSFER", "CARD", "OTHER"].map((v) => ({ value: v, label: titleCase(v) })) },
      { name: "reference", label: "Payment reference (optional)" }],
    complaint: [{ name: "title", label: "What needs attention?", required: true }, { name: "category", label: "Category", required: true, options: ["MAINTENANCE", "CLEANING", "ELECTRICAL", "PLUMBING", "OTHER"].map((v) => ({ value: v, label: titleCase(v) })) },
      { name: "description", label: "Describe the issue (at least 10 characters)", required: true, type: "textarea" }],
    notice: [{ name: "title", label: "Notice title", required: true }, { name: "audience", label: "Audience", required: true, options: ["ALL", "STUDENTS", "WARDENS"].map((v) => ({ value: v, label: titleCase(v) })) },
      { name: "body", label: "Message", required: true, type: "textarea" }],
    status: rows?.type === "student"
      ? [{ name: "full_name", label: "Full name", defaultValue: String(rows.full_name ?? ""), required: true },
        { name: "phone", label: "Phone", defaultValue: String(rows.phone ?? "") }, { name: "course", label: "Course", defaultValue: String(rows.course ?? "") },
        { name: "guardian_name", label: "Guardian name", defaultValue: String(rows.guardian_name ?? "") },
        { name: "guardian_phone", label: "Guardian phone", defaultValue: String(rows.guardian_phone ?? "") },
        { name: "status", label: "Student status", required: true, defaultValue: String(rows.status ?? "ACTIVE"), options: ["ACTIVE", "INACTIVE"].map((v) => ({ value: v, label: titleCase(v) })) }]
      : [{ name: "status", label: "Complaint status", required: true, defaultValue: String(rows?.status ?? "OPEN"), options: ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"].map((v) => ({ value: v, label: titleCase(v) })) }],
    password: [{ name: "email", label: "Account email", type: "email", required: true }],
    "password-confirm": [{ name: "token", label: "One-time token from your email", required: true },
      { name: "password", label: "New password (12+ characters)", type: "password", required: true }],
  };
  const isWide = fields[kind].length > 4;
  return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div className="modal-heading"><div><p className="eyebrow">NORTHFIELD WORKSPACE</p><h2 id="dialog-title">{title[kind]}</h2></div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={18} /></button></div>
    <form onSubmit={onSubmit}>{error && <div className="alert-error" role="alert">{error}</div>}{notice && <div className="toast-success modal-success" role="status"><Check size={16} />{notice}</div>}<div className={`form-grid ${isWide ? "form-grid-wide" : ""}`}>{fields[kind].map((field) => <label className={`form-field ${field.type === "textarea" ? "field-full" : ""}`} key={field.name}>{field.label}
      {field.options ? <select name={field.name} defaultValue={field.defaultValue} required={field.required} disabled={!field.options.length}><option value="">Choose…</option>{field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
        : field.type === "textarea" ? <textarea name={field.name} required={field.required} minLength={kind === "complaint" ? 10 : 5} maxLength={kind === "complaint" ? 3000 : 5000} rows={4} />
          : <input name={field.name} type={field.type ?? "text"} required={field.required} min={field.type === "number" ? 0 : undefined} step={field.type === "number" ? "0.01" : undefined} minLength={field.name === "password" ? 12 : undefined} maxLength={field.type === "password" ? 256 : undefined} defaultValue={field.defaultValue} />}</label>)}</div>
      {kind === "payment" && <p className="modal-note"><ShieldCheck size={15} /> This records a payment already received by your organization. No payment is processed by this form.</p>}
      {kind === "password" && <p className="modal-note">A one-time reset token will be emailed if this address belongs to an account. Email delivery must be configured by your administrator.</p>}
      <div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? "Saving…" : kind === "payment" ? "Record payment" : kind === "password" ? "Send reset email" : kind === "password-confirm" ? "Update password" : "Save changes"}</button></div>
    </form></section></div>;
}

function Login({ onSubmit, busy, error, notice, onReset, dialog, onClose, onAction }: {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void; busy: boolean; error: string; notice: string;
  onReset: () => void; dialog: DialogKind | null; onClose: () => void; onAction: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const [showPassword, setShowPassword] = useState(false);
  return <div className="login-page"><section className="login-aside"><div className="brand-lockup login-brand"><span className="brand-icon"><Building2 size={20} /></span><span>northfield<span className="brand-sub">HOSTEL MANAGEMENT</span></span></div><div className="login-promise"><span className="login-overline">A BETTER WAY TO LIVE ON CAMPUS</span><h1>Everything hostel life needs, in one place.</h1><p>Stay connected to your community. Manage your room, payments, maintenance and more with ease.</p><div className="login-perks"><span><Check size={15} /> A more welcoming campus</span><span><Check size={15} /> Support that stays in the loop</span><span><Check size={15} /> Your essentials, always at hand</span></div></div><span className="login-foot">NORTHFIELD CAMPUS · STUDENT LIVING</span><div className="login-art" /></section>
    <main className="login-main"><form className="login-card" onSubmit={onSubmit}><span className="mobile-login-brand"><Building2 size={22} /> northfield</span><span className="login-overline form-overline block">WELCOME TO YOUR COMMUNITY</span><h2>Sign in to continue.</h2><p className="login-intro">Use your registered hostel account to access your dashboard.</p>{error && <div className="alert-error" role="alert">{error}</div>}
      {notice && <div className="login-notice" role="status"><Check size={15} />{notice}</div>}
      <label className="form-field">Email address<input type="email" name="email" placeholder="you@school.edu" autoComplete="username" required /></label>
      <label className="form-field">Password<span className="password-field"><input type={showPassword ? "text" : "password"} name="password" placeholder="Enter your password" autoComplete="current-password" required /><button type="button" onClick={() => setShowPassword(!showPassword)}>{showPassword ? "Hide" : "Show"}</button></span></label>
      <div className="login-options"><span>Secure role-based access</span><button type="button" className="text-button" onClick={onReset}>Forgot password?</button></div>
      <button className="button button-primary login-button" disabled={busy}>{busy ? "Signing in…" : "Sign in"}<span>→</span></button>
      <p className="login-help">Need an account? Contact your hostel administrator.</p></form><span className="login-legal">Your account access is managed by your institution.</span></main>
    {dialog && <Dialog kind={dialog} rows={null} hostels={[]} wardens={[]} rooms={[]} students={[]} invoices={[]} error={error} notice={notice} onClose={onClose} onSubmit={onAction} busy={busy} />}
  </div>;
}

export default App;
