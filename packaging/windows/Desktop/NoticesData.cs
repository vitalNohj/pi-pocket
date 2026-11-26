using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;

namespace PiPocket
{
    sealed class NoticeData
    {
        public string Tag, Title, Body, Path, Stamp, Approval, Call;
        public bool May, Cut;
        public bool Finish { get { return Approval == null && Tag.StartsWith("done-", StringComparison.Ordinal); } }

        public static NoticeData Read(IDictionary<string, object> body)
        {
            if (body == null) { return null; }
            string path = BridgeProtocol.Text(body, "url", 100), tag = BridgeProtocol.Text(body, "tag", 200);
            if (!BridgeProtocol.IsTarget(path) || string.IsNullOrWhiteSpace(tag)) { return null; }
            var notice = new NoticeData {
                Tag = tag, Path = path, Stamp = BridgeProtocol.Text(body, "stamp", 80) ?? "",
                Title = Plain(BridgeProtocol.Text(body, "title", 200), 100), Body = Plain(BridgeProtocol.Text(body, "body", 400), 400),
            };
            object extra;
            if (body.TryGetValue("approval", out extra))
            {
                var approval = extra as IDictionary<string, object>;
                if (approval == null) { return null; }
                notice.Approval = BridgeProtocol.Text(approval, "id", 200);
                notice.Call = BridgeProtocol.Text(approval, "call", 8192);
                if (string.IsNullOrEmpty(notice.Approval) || notice.Call == null) { return null; }
                notice.May = BridgeProtocol.Flag(approval, "may");
                notice.Cut = BridgeProtocol.Flag(approval, "cut");
            }
            return notice;
        }

        public static NoticeData Group(IList<NoticeData> finishes)
        {
            if (finishes.Count == 0) { return null; }
            var latest = finishes[finishes.Count - 1];
            if (finishes.Count == 1) { return latest; }
            const string prefix = "Pi finished · ";
            const int listed = 6;
            var names = finishes.Reverse().Take(listed).Select(each => each.Title.StartsWith(prefix, StringComparison.Ordinal)
                ? each.Title.Substring(prefix.Length) : each.Title).ToList();
            if (finishes.Count > listed) { names.Add("and " + (finishes.Count - listed) + " more"); }
            return new NoticeData {
                Title = finishes.Count + " sessions finished", Body = string.Join("\n", names), Path = latest.Path,
            };
        }

        public static string Plain(string value, int limit)
        {
            bool complete;
            return Mark(value ?? "", limit, false, out complete);
        }

        public static string Mark(string value, int limit, bool alreadyCut, out bool complete)
        {
            var result = new StringBuilder();
            bool changed = false, cut = alreadyCut;
            for (int offset = 0; offset < value.Length;)
            {
                int length = char.IsSurrogatePair(value, offset) ? 2 : 1;
                int scalar = length == 2 ? char.ConvertToUtf32(value, offset) : value[offset];
                UnicodeCategory category = CharUnicodeInfo.GetUnicodeCategory(value, offset);
                bool hidden = category == UnicodeCategory.Control || category == UnicodeCategory.Format ||
                    category == UnicodeCategory.LineSeparator || category == UnicodeCategory.ParagraphSeparator ||
                    category == UnicodeCategory.Surrogate || (category == UnicodeCategory.SpaceSeparator && scalar != 32) ||
                    scalar == 0x034F || scalar == 0x115F || scalar == 0x1160 || scalar == 0x17B4 || scalar == 0x17B5 ||
                    (scalar >= 0x180B && scalar <= 0x180F) || scalar == 0x3164 || scalar == 0xFFA0 ||
                    (scalar >= 0xFE00 && scalar <= 0xFE0F) || (scalar >= 0xE0000 && scalar <= 0xE0FFF);
                string part = hidden ? "[U+" + scalar.ToString("X4", CultureInfo.InvariantCulture) + "]" : value.Substring(offset, length);
                if (result.Length + part.Length > limit) { cut = true; break; }
                result.Append(part);
                changed |= hidden;
                offset += length;
            }
            if (cut) { result.Append(" … [shortened]"); }
            complete = !cut && !changed && value.Length > 0;
            return result.ToString();
        }

        public bool CanAllow(string mode, int limit, out string body)
        {
            bool whole;
            body = Mark(Call, Math.Min(2000, Math.Max(20, limit)), Cut, out whole);
            if (!May || mode == "never") { return false; }
            if (mode == "always") { return true; }
            // Keep a generous margin for the collapsed banner, non-default fonts and text scaling. Open the app
            // instead when the text is not a single, very short line of ordinary printable ASCII.
            if (!whole || Call.Length > 24 || Call.Trim() != Call) { return false; }
            foreach (char character in Call) { if (character < ' ' || character > '~') { return false; } }
            return true;
        }
    }

    sealed class NoticeTicket
    {
        public string Token, Lease, Path, Approval, Slot;
        public int Auth;
        public bool Allow;
        public DateTime Expires;

        public bool Matches(string lease, int auth, string action, DateTime now)
        {
            return lease != null && Lease == lease && Auth == auth && now < Expires &&
                (action == "open" || (Approval != null && (action == "deny" || (action == "allow" && Allow))));
        }
    }
}
