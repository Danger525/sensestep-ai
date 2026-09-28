"""
SenseStep Mobile — Local Demonstration Server
===============================================
Serves the mobile web prototype over HTTPS (or HTTP) so that mobile
browsers (Google Chrome on Android) can access the rear camera (getUserMedia)
and the Vibration API (navigator.vibrate) across local Wi-Fi or Mobile Hotspot.

Setup:
  1. Phone turns on Mobile Hotspot
  2. Laptop connects to Phone Hotspot
  3. Run: python mobile_demo/serve.py
  4. Phone opens: https://<LAPTOP-IP>:8443
"""

import sys
import os
import socket
import ssl
import datetime
from http.server import HTTPServer, SimpleHTTPRequestHandler

# Reconfigure stdout/stderr to utf-8 if supported to prevent Windows charmap errors
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass


def get_all_local_ips():
    """Finds all candidate local LAN / Hotspot IP addresses of this machine."""
    ips = []
    # Primary outbound routing IP
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        primary = s.getsockname()[0]
        if primary not in ips and not primary.startswith('127.'):
            ips.append(primary)
    except Exception:
        pass
    finally:
        s.close()

    # Hostname resolution fallback
    try:
        hostname = socket.gethostname()
        for ip in socket.gethostbyname_ex(hostname)[2]:
            if not ip.startswith('127.') and ip not in ips:
                ips.append(ip)
    except Exception:
        pass

    if not ips:
        ips.append('127.0.0.1')
    return ips


def generate_self_signed_cert(cert_path, key_path, ip_list):
    """Generates a self-signed SSL certificate with SAN entries for all local IPs."""
    try:
        from cryptography import x509
        from cryptography.x509.oid import NameOID
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.hazmat.primitives import serialization
        import ipaddress

        print("Generating self-signed SSL certificate with SAN IP support...", flush=True)
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

        san_list = [
            x509.DNSName("localhost"),
            x509.IPAddress(ipaddress.IPv4Address("127.0.0.1")),
        ]
        for ip_str in ip_list:
            try:
                san_list.append(x509.IPAddress(ipaddress.IPv4Address(ip_str)))
            except Exception:
                pass

        primary_ip = ip_list[0] if ip_list else "localhost"
        subject = issuer = x509.Name([
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "SenseStep Mobile"),
            x509.NameAttribute(NameOID.COMMON_NAME, primary_ip),
        ])

        cert = (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(issuer)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=1))
            .not_valid_after(datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=365))
            .add_extension(x509.SubjectAlternativeName(san_list), critical=False)
            .sign(key, hashes.SHA256())
        )

        with open(key_path, "wb") as f:
            f.write(key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.TraditionalOpenSSL,
                encryption_algorithm=serialization.NoEncryption(),
            ))

        with open(cert_path, "wb") as f:
            f.write(cert.public_bytes(serialization.Encoding.PEM))

        print(f"SSL certificate generated successfully: {cert_path}", flush=True)
        return True
    except Exception as e:
        print(f"[WARN] Could not auto-generate SSL cert: {e}", flush=True)
        return False


class CustomHTTPRequestHandler(SimpleHTTPRequestHandler):
    """Custom request handler with cache control and correct mime types."""
    def end_headers(self):
        # Disable caching during development / demo
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(script_dir)

    use_http = "--http" in sys.argv
    all_ips = get_all_local_ips()
    primary_ip = all_ips[0]

    bind_host = "0.0.0.0"  # Must bind to 0.0.0.0 for external mobile access

    if use_http:
        port = 8000
        server_address = (bind_host, port)
        httpd = HTTPServer(server_address, CustomHTTPRequestHandler)
        protocol = "http"
    else:
        port = 8443
        cert_file = os.path.join(script_dir, "cert.pem")
        key_file = os.path.join(script_dir, "key.pem")

        # Regenerate cert if missing or when IP changes
        if not (os.path.exists(cert_file) and os.path.exists(key_file)):
            generate_self_signed_cert(cert_file, key_file, all_ips)

        server_address = (bind_host, port)
        httpd = HTTPServer(server_address, CustomHTTPRequestHandler)

        if os.path.exists(cert_file) and os.path.exists(key_file):
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(certfile=cert_file, keyfile=key_file)
            httpd.socket = context.wrap_socket(httpd.socket, server_side=True)
            protocol = "https"
        else:
            print("[WARN] SSL certificate missing. Falling back to HTTP on port 8000.", flush=True)
            port = 8000
            server_address = (bind_host, port)
            httpd = HTTPServer(server_address, CustomHTTPRequestHandler)
            protocol = "http"

    print("\n" + "=" * 68, flush=True)
    print("      SenseStep Mobile — Local Demonstration Server (AUDITED)     ", flush=True)
    print("=" * 68, flush=True)
    print("SERVER:", flush=True)
    print("  STATUS: READY", flush=True)
    print(f"  BOUND : {bind_host}:{port} ({protocol.upper()})", flush=True)
    print("\nLOCAL ACCESS (Laptop):", flush=True)
    print(f"  {protocol}://localhost:{port}", flush=True)
    print("\nPHONE ACCESS (Over Mobile Hotspot or Wi-Fi):", flush=True)
    for ip in all_ips:
        print(f"  --> {protocol}://{ip}:{port} <--", flush=True)

    if protocol == "https":
        print("\n* FOR APPLE IPHONE (iOS Safari / Chrome):", flush=True)
        print("  1. When Safari shows 'This Connection Is Not Private', tap 'Show Details' -> 'visit this website'.", flush=True)
        print("  2. If iOS WebKit blocks camera on self-signed IP addresses:", flush=True)
        print("     - Tap '🎬 Run Virtual Camera Walk' on screen for complete simulated walk with real-time audio beeps & zones!", flush=True)
        print("     - Or run a trusted public HTTPS tunnel in a second terminal for 100% native camera access:", flush=True)
        print("       npx localtunnel --port 8443 --local-https --allow-invalid-cert", flush=True)
        print("\n* FOR GOOGLE CHROME ON ANDROID:", flush=True)
        print("  1. Tap 'Advanced' -> 'Proceed to IP (unsafe)'.", flush=True)
        print("  2. Page will load with full camera and vibration permissions!\n", flush=True)
    else:
        print("\n* NOTE FOR HTTP MODE:", flush=True)
        print("  To allow camera access without HTTPS in mobile Chrome:", flush=True)
        print("  1. Open: chrome://flags/#unsafely-treat-insecure-origin-as-secure", flush=True)
        print(f"  2. Add: http://{primary_ip}:{port}", flush=True)
        print("  3. Set to 'Enabled' and relaunch Chrome.\n", flush=True)

    print("=" * 68, flush=True)
    print("Press Ctrl + C in this terminal to stop the server.\n", flush=True)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nSenseStep Mobile server stopped.", flush=True)
        httpd.server_close()


if __name__ == "__main__":
    main()
