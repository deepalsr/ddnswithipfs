
import { abi, contractAddress } from './contract.js';

// Use ethers from global window (UMD)
const { ethers } = window;

let signer, contract;
let domainList = [];

// Your Pinata JWT token here
const PINATA_JWT_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySW5mb3JtYXRpb24iOnsiaWQiOiIxZjhmYjExNy0wOWI0LTRmMjItODMzOS0zY2EwOTFhYzU5MzgiLCJlbWFpbCI6ImRlZXBhbHNocnRAZ21haWwuY29tIiwiZW1haWxfdmVyaWZpZWQiOnRydWUsInBpbl9wb2xpY3kiOnsicmVnaW9ucyI6W3siZGVzaXJlZFJlcGxpY2F0aW9uQ291bnQiOjEsImlkIjoiRlJBMSJ9LHsiZGVzaXJlZFJlcGxpY2F0aW9uQ291bnQiOjEsImlkIjoiTllDMSJ9XSwidmVyc2lvbiI6MX0sIm1mYV9lbmFibGVkIjpmYWxzZSwic3RhdHVzIjoiQUNUSVZFIn0sImF1dGhlbnRpY2F0aW9uVHlwZSI6InNjb3BlZEtleSIsInNjb3BlZEtleUtleSI6ImVlMDUxYTVjNTQxODFiOTlmOTc0Iiwic2NvcGVkS2V5U2VjcmV0IjoiYTgwZDc5YWM5M2I5YzQzYTU4NzJjNTA5MjI4YmEyNmEzNmM2NDBhNTY2NjUwNWZiYzZjYjFjNDJiNWQzY2Q2YyIsImV4cCI6MTc4MDQ4ODIxM30.ZQfFomgkfxEbIdpVBbg2xaXjgeu3pgkbxhzGN8vYBOY";

// Validate domain extension
function isValidDomainExtension(domain) {
  const allowedExtensions = ['.eth', '.ddns'];
  return allowedExtensions.some(ext => domain.toLowerCase().endsWith(ext));
}

document.getElementById('connectWallet').onclick = async () => {
  if (!window.ethereum) {
    alert("Please install MetaMask!");
    return;
  }

  const provider = new ethers.providers.Web3Provider(window.ethereum);
  await provider.send('eth_requestAccounts', []);
  signer = provider.getSigner();
  const address = await signer.getAddress();

  
  const message = "Log in to Decentralized DNS";
  const signature = await signer.signMessage(message);
  const recoveredAddress = ethers.utils.verifyMessage(message, signature);

  if (recoveredAddress.toLowerCase() !== address.toLowerCase()) {
    alert("Signature verification failed!");
    return;
  }

  
  localStorage.setItem("userAddress", address);
  document.getElementById('walletAddress').innerText = 'Connected: ' + address;

  // Connect contract
  contract = new ethers.Contract(contractAddress, abi, signer);

  // Load past domains
  await loadPastDomains();

  // Remove previous listeners (if any)
  contract.removeAllListeners("DomainRegistered");
  contract.removeAllListeners("CIDUpdated");

  // Listen for new DomainRegistered events
  contract.on("DomainRegistered", (name, owner, cid) => {
    console.log(`New domain registered: ${name} by ${owner} with CID ${cid}`);

    if (!domainList.find(d => d.name === name)) {
      domainList.push({ name, owner, cid });
      updateDomainListUI();
    }
  });

  // Listen for CIDUpdated events
  contract.on("CIDUpdated", (name, newCid) => {
    console.log(`CID updated for domain: ${name} to new CID: ${newCid}`);

    const domainIndex = domainList.findIndex(d => d.name === name);
    if (domainIndex !== -1) {
      domainList[domainIndex].cid = newCid;
      updateDomainListUI();
    }
  });
};


async function uploadToPinata(file) {
  const url = "https://api.pinata.cloud/pinning/pinFileToIPFS";
  const data = new FormData();
  data.append('file', file);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PINATA_JWT_TOKEN}`,
    },
    body: data
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Pinata upload failed: ${res.status} ${res.statusText} - ${errorText}`);
  }

  const json = await res.json();
  return json.IpfsHash; // preserve exact CID casing here
}

// Register Domain
document.getElementById('registerBtn').onclick = async () => {
  const domain = document.getElementById('domainInput').value.trim();
  const fileInput = document.getElementById('fileInput');

  if (!domain) {
    alert("Please enter a domain name");
    return;
  }

  // Validate domain extension
  if (!isValidDomainExtension(domain)) {
    alert("Only .eth and .ddns domains are allowed");
    return;
  }

  if (fileInput.files.length === 0) {
    alert("Please select a file");
    return;
  }

  try {
    const cid = await uploadToPinata(fileInput.files[0]);
    console.log("Uploaded CID (case preserved):", cid);

    const tx = await contract.registerDomain(domain, cid);
    await tx.wait();

    document.getElementById('registerStatus').innerText = `Registered ${domain} with CID: ${cid}`;
  } catch (error) {
    console.error(error);
    alert("Error registering domain: " + error.message);
  }
};

// Resolve & Preview the site stored as a ZIP on IPFS - Fixed to prevent navigation
document.getElementById('resolveBtn').onclick = async () => {
  const domain = document.getElementById('resolveInput').value.trim();
  const statusEl = document.getElementById('resolveStatus');
  const miniBrowser = document.getElementById('miniBrowser');

  miniBrowser.innerHTML = '';
  statusEl.textContent = '';
  document.getElementById('resolvedDomain').textContent = '';
  document.getElementById('resolvedCid').textContent = '';

  if (!domain) return alert("Please enter a domain name");

  try {
    const cid = await contract.getCID(domain);
    if (!cid) throw new Error("Domain not registered");

    document.getElementById('resolvedDomain').textContent = domain;
    document.getElementById('resolvedCid').textContent = cid;
    statusEl.textContent = "📦 Loading site from IPFS...";

    const response = await fetch(`https://ipfs.io/ipfs/${cid}`);
    const buffer = await response.arrayBuffer();
    const zip = await JSZip.loadAsync(buffer);

    const files = {}, blobs = {};
    await Promise.all(Object.entries(zip.files).map(async ([path, file]) => {
      const content = await file.async('uint8array');
      let type = 'text/plain';
      if (path.endsWith('.html')) type = 'text/html';
      else if (path.endsWith('.js')) type = 'application/javascript';
      else if (path.endsWith('.css')) type = 'text/css';
      else if (/\.(png|jpg|jpeg|gif|svg)$/.test(path)) type = 'image/' + path.split('.').pop();
      else if (/\.(woff2?|ttf|otf)$/.test(path)) type = 'font/' + path.split('.').pop();

      const blob = new Blob([content], { type });
      blobs[path] = URL.createObjectURL(blob);
    }));

    const indexPath = Object.keys(blobs).find(p => p.endsWith('index.html'));
    if (!indexPath) throw new Error("index.html not found in zip");

    const decoder = new TextDecoder();
    const rawHTML = decoder.decode(await zip.file(indexPath).async('uint8array'));

    // Rewriting paths in HTML to match blob URLs and remove target="_blank" attributes
    const html = rawHTML
      .replace(/(src|href)=["']([^"']+)["']/g, (match, attr, path) => {
        if (blobs[path]) {
          return `${attr}="${blobs[path]}"`;
        } else {
          console.warn(`No blob found for path: ${path}`);
          return match;
        }
      })
      .replace(/target=["']_blank["']/g, '') // Remove target="_blank" to prevent new tabs
      .replace(/<a([^>]+)href=["']([^"']+)["']/g, (match, attributes, href) => {
        // Convert external links to prevent navigation
        if (href.startsWith('http') || href.startsWith('//')) {
          return `<a${attributes}href="javascript:void(0)" onclick="alert('External link: ${href}')"`;
        }
        return match;
      });

    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    iframe.style.width = '100%';
    iframe.style.height = '600px';
    iframe.style.border = '1px solid #e2e8f0';
    iframe.style.borderRadius = '8px';
    iframe.srcdoc = html;
    
    // Prevent iframe from navigating parent window
    iframe.onload = () => {
      try {
        iframe.contentWindow.parent = iframe.contentWindow;
        iframe.contentWindow.top = iframe.contentWindow;
      } catch (e) {
        // Ignore cross-origin errors
      }
    };
    
    miniBrowser.appendChild(iframe);

    statusEl.textContent = '✅ Site loaded from IPFS';
  } catch (err) {
    console.error(err);
    statusEl.textContent = '❌ Failed to load site';
    alert("Preview failed: " + err.message);
  }
};

// Check Ownership
document.getElementById('checkOwnershipBtn').onclick = async () => {
  const domain = document.getElementById('ownershipInput').value.trim();
  
  if (!domain) {
    alert("Please enter a domain name");
    return;
  }

  if (!signer) {
    alert("Please connect your wallet first.");
    return;
  }

  try {
    const owner = await contract.getOwner(domain);
    const currentUser = await signer.getAddress();
    const isOwner = owner.toLowerCase() === currentUser.toLowerCase();

    document.getElementById('ownershipStatus').innerText = 
      `Owner: ${owner} ${isOwner ? '(You own this domain)' : ''}`;
  } catch (error) {
    console.error(error);
    document.getElementById('ownershipStatus').innerText = "Domain not found or error occurred";
  }
};


// Update CID
document.getElementById('updateCidBtn').onclick = async () => {
  const domain = document.getElementById('updateDomainInput').value.trim();
  const newCid = document.getElementById('newCidInput').value.trim();

  if (!domain || !newCid) {
    alert("Please enter both domain name and new CID");
    return;
  }

  try {
    const tx = await contract.updateCID(domain, newCid);
    await tx.wait();
    document.getElementById('updateCidStatus').innerText = `Updated CID for ${domain} to: ${newCid}`;
  } catch (error) {
    console.error(error);
    alert("Error updating CID: " + error.message);
  }
};

// Transfer Domain Ownership
document.getElementById('transferDomainBtn').onclick = async () => {
  const domain = document.getElementById('transferDomainInput').value.trim();
  const newOwner = document.getElementById('newOwnerInput').value.trim();

  if (!domain || !ethers.utils.isAddress(newOwner)) {
    alert("Please enter valid domain and new owner address");
    return;
  }

  try {
    const tx = await contract.transferDomain(domain, newOwner);
    await tx.wait();
    document.getElementById('transferDomainStatus').innerText = `Ownership transferred for ${domain} to ${newOwner}`;
  } catch (error) {
    console.error(error);
    alert("Error transferring ownership: " + error.message);
  }
};

// Update domain list UI table
function updateDomainListUI() {
  const tbody = document.getElementById('domainsTable');
  tbody.innerHTML = ''; // Clear existing rows

  domainList.forEach(domain => {
    const row = document.createElement('tr');

    const nameCell = document.createElement('td');
    nameCell.innerText = domain.name;
    row.appendChild(nameCell);
    
    const ownerCell = document.createElement('td');
    ownerCell.innerText = domain.owner;
    row.appendChild(ownerCell);

    const cidCell = document.createElement('td');
    cidCell.innerText = domain.cid;
    row.appendChild(cidCell);

    tbody.appendChild(row);
  });
}

// Load past registered domains by querying past events
async function loadPastDomains() {
  const status = document.getElementById("domainListStatus");
  status.textContent = "⏳ Fetching registered domains...";

  try {
    const query = `
      query {
        getAllDomains {
          name
          owner
          cid
        }
      }
    `;

    const res = await fetch("http://localhost:4000/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });

    const result = await res.json();
    const domains = result.data?.getAllDomains || [];

    domainList = domains;
    updateDomainListUI();

    status.textContent = domains.length === 0
      ? "No domains registered yet."
      : `✅ ${domains.length} domain(s) loaded.`;
  } catch (error) {
    console.error("Error loading domains from GraphQL:", error);
    status.textContent = "❌ Failed to load domains.";
  }
}
