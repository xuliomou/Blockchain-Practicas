import React, { useCallback, useEffect, useState } from "react";
import "./App.css";
import { create } from "kubo-rpc-client";
import { ethers } from "ethers";

import { addresses, abis } from "./contracts";

// API del nodo IPFS local (contenedor ipfs_host) y su gateway para ver los ficheros
const IPFS_API = "http://127.0.0.1:5001/api/v0";
const IPFS_GATEWAY = "http://127.0.0.1:8080/ipfs/";
const SEPOLIA_CHAIN_ID = 11155111;

const ESTADOS = ["Disponible", "Alquilado", "Finalizado"];
const TIPOS = [
  "Contrato de alquiler",
  "Inventario de entrada",
  "Inventario de salida",
  "Prueba de daños",
];

const mismaDireccion = (a, b) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

const acortar = (dir) => (dir ? `${dir.slice(0, 6)}…${dir.slice(-4)}` : "");

// Extrae el motivo del revert de los distintos formatos de error de ethers/MetaMask
function mensajeError(err) {
  return (
    err?.reason ||
    err?.error?.data?.message ||
    err?.error?.message ||
    err?.data?.message ||
    err?.message ||
    String(err)
  );
}

function App() {
  const [cuenta, setCuenta] = useState("");
  const [redCorrecta, setRedCorrecta] = useState(true);
  const [datos, setDatos] = useState(null);
  const [documentos, setDocumentos] = useState([]);
  const [fichero, setFichero] = useState(null);
  const [tipo, setTipo] = useState(0);
  const [descripcion, setDescripcion] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [mensaje, setMensaje] = useState("");

  const hayWallet = typeof window.ethereum !== "undefined";

  const obtenerProveedor = () =>
    new ethers.providers.Web3Provider(window.ethereum);

  const obtenerContrato = (proveedorOSigner) =>
    new ethers.Contract(addresses.alquiler, abis.alquiler, proveedorOSigner);

  // Lee de la blockchain el estado del alquiler y la lista de documentos
  const cargarDatos = useCallback(async (direccion) => {
    try {
      const proveedor = obtenerProveedor();
      const red = await proveedor.getNetwork();
      setRedCorrecta(red.chainId === SEPOLIA_CHAIN_ID);

      const contrato = obtenerContrato(proveedor);
      const [
        propietario,
        inquilino,
        precio,
        fianza,
        estado,
        cidContrato,
        evidencias,
        balance,
        saldo,
        docs,
      ] = await Promise.all([
        contrato.propietario(),
        contrato.inquilino(),
        contrato.precioAlquiler(),
        contrato.fianza(),
        contrato.estado(),
        contrato.cidContrato(),
        contrato.evidenciasDanos(),
        contrato.obtenerBalanceContrato(),
        contrato.saldoPendiente(direccion),
        contrato.obtenerDocumentos(),
      ]);

      setDatos({
        propietario,
        inquilino,
        precio,
        fianza,
        estado: Number(estado),
        cidContrato,
        evidencias: evidencias.toNumber(),
        balance,
        saldo,
      });

      setDocumentos(
        docs.map((d, i) => ({
          id: i,
          cid: d.cid,
          tipo: Number(d.tipo),
          autor: d.autor,
          fecha: new Date(d.fecha.toNumber() * 1000).toLocaleString(),
          descripcion: d.descripcion,
        }))
      );
    } catch (err) {
      setMensaje(`Error leyendo el contrato: ${mensajeError(err)}`);
    }
  }, []);

  const conectar = async () => {
    try {
      const proveedor = obtenerProveedor();
      const cuentas = await proveedor.send("eth_requestAccounts", []);
      if (cuentas.length > 0) {
        setCuenta(cuentas[0]);
        setMensaje("");
        await cargarDatos(cuentas[0]);
      }
    } catch (err) {
      setMensaje(`No se pudo conectar con MetaMask: ${mensajeError(err)}`);
    }
  };

  // Reconecta si ya habia permiso y recarga al cambiar de cuenta o de red en MetaMask
  useEffect(() => {
    if (!hayWallet) return;

    window.ethereum.request({ method: "eth_accounts" }).then((cuentas) => {
      if (cuentas.length > 0) {
        setCuenta(cuentas[0]);
        cargarDatos(cuentas[0]);
      }
    });

    const alCambiarCuenta = (cuentas) => {
      setCuenta(cuentas[0] || "");
      if (cuentas[0]) cargarDatos(cuentas[0]);
    };
    const alCambiarRed = () => window.location.reload();

    window.ethereum.on("accountsChanged", alCambiarCuenta);
    window.ethereum.on("chainChanged", alCambiarRed);
    return () => {
      window.ethereum.removeListener("accountsChanged", alCambiarCuenta);
      window.ethereum.removeListener("chainChanged", alCambiarRed);
    };
  }, [hayWallet, cargarDatos]);

  // Envia una transaccion, espera a que se mine y refresca la pantalla
  const ejecutar = async (texto, accion) => {
    setOcupado(true);
    setMensaje(`${texto}: confirma la transacción en MetaMask…`);
    try {
      const signer = obtenerProveedor().getSigner();
      const tx = await accion(obtenerContrato(signer));
      setMensaje(`${texto}: esperando confirmación (${acortar(tx.hash)})…`);
      await tx.wait();
      setMensaje(`${texto}: hecho. Tx ${tx.hash}`);
      await cargarDatos(cuenta);
    } catch (err) {
      setMensaje(`${texto}: ERROR — ${mensajeError(err)}`);
    } finally {
      setOcupado(false);
    }
  };

  // 1) sube el fichero a IPFS  2) registra su CID en el contrato inteligente
  const subirDocumento = async (e) => {
    e.preventDefault();
    if (!fichero) {
      setMensaje("Selecciona antes un fichero.");
      return;
    }

    setOcupado(true);
    let cid;
    try {
      setMensaje("Subiendo el fichero a IPFS…");
      const cliente = create({ url: IPFS_API });
      const contenido = new Uint8Array(await fichero.arrayBuffer());
      const resultado = await cliente.add(contenido);
      cid = resultado.cid.toString();

      // Lo copia al MFS del nodo para que aparezca en la pestaña "Files" del panel
      try {
        await cliente.files.cp(`/ipfs/${cid}`, `/${cid}`);
      } catch (errMfs) {
        console.log("Aviso MFS (no critico):", errMfs.message);
      }
    } catch (err) {
      setMensaje(
        `Error subiendo a IPFS (¿está el nodo arrancado y el CORS habilitado?): ${mensajeError(err)}`
      );
      setOcupado(false);
      return;
    }

    await ejecutar(`Registrar documento ${acortar(cid)}`, (contrato) =>
      contrato.registrarDocumento(cid, tipoSeleccionado, descripcion)
    );
    setDescripcion("");
  };

  const alquilar = () =>
    ejecutar("Alquilar", (contrato) =>
      contrato.alquilar(datos.cidContrato, {
        value: datos.precio.add(datos.fianza),
      })
    );

  const finalizar = () =>
    ejecutar("Finalizar sin incidencias", (contrato) =>
      contrato.finalizarSinIncidencias()
    );

  const reclamar = () =>
    ejecutar("Reclamar por daños", (contrato) => contrato.reclamarPorDanos());

  const retirar = () =>
    ejecutar("Retirar fondos", (contrato) => contrato.retirarFondos());

  // ---------- Render ----------

  if (!hayWallet) {
    return (
      <div className="App">
        <h1>Alquiler Seguro + IPFS</h1>
        <p className="aviso">Instala MetaMask para usar la aplicación.</p>
      </div>
    );
  }

  const esPropietario = datos && mismaDireccion(cuenta, datos.propietario);
  const esInquilino = datos && mismaDireccion(cuenta, datos.inquilino);
  const rol = esPropietario ? "Propietario" : esInquilino ? "Inquilino" : "Visitante";

  // Tipos de documento que la cuenta actual puede subir en el estado actual
  const tiposPermitidos = [];
  if (datos) {
    if (datos.estado === 0 && esPropietario) tiposPermitidos.push(0);
    if (datos.estado === 1 && (esPropietario || esInquilino)) tiposPermitidos.push(1, 2);
    if (datos.estado === 1 && esPropietario) tiposPermitidos.push(3);
  }
  const tipoSeleccionado = tiposPermitidos.includes(tipo) ? tipo : tiposPermitidos[0];

  return (
    <div className="App">
      <h1>Alquiler Seguro + IPFS</h1>
      <p className="subtitulo">
        Los documentos del alquiler se guardan en IPFS y su CID queda registrado
        en Ethereum.
      </p>

      {!cuenta ? (
        <button className="btn" onClick={conectar}>
          Conectar MetaMask
        </button>
      ) : (
        <p>
          Cuenta: <code>{cuenta}</code> — <strong>{rol}</strong>
        </p>
      )}

      {!redCorrecta && (
        <p className="aviso">Cambia MetaMask a la red Sepolia.</p>
      )}

      {mensaje && <p className="mensaje">{mensaje}</p>}

      {datos && (
        <>
          <section className="tarjeta">
            <h2>Estado del alquiler</h2>
            <table>
              <tbody>
                <tr>
                  <th>Estado</th>
                  <td>{ESTADOS[datos.estado]}</td>
                </tr>
                <tr>
                  <th>Propietario</th>
                  <td><code>{datos.propietario}</code></td>
                </tr>
                <tr>
                  <th>Inquilino</th>
                  <td>
                    {datos.inquilino === ethers.constants.AddressZero ? (
                      "—"
                    ) : (
                      <code>{datos.inquilino}</code>
                    )}
                  </td>
                </tr>
                <tr>
                  <th>Alquiler</th>
                  <td>{ethers.utils.formatEther(datos.precio)} ETH</td>
                </tr>
                <tr>
                  <th>Fianza</th>
                  <td>{ethers.utils.formatEther(datos.fianza)} ETH</td>
                </tr>
                <tr>
                  <th>Contrato vigente (CID)</th>
                  <td>
                    {datos.cidContrato ? (
                      <a href={IPFS_GATEWAY + datos.cidContrato} target="_blank" rel="noreferrer">
                        {datos.cidContrato}
                      </a>
                    ) : (
                      "Aún no subido"
                    )}
                  </td>
                </tr>
                <tr>
                  <th>Pruebas de daños</th>
                  <td>{datos.evidencias}</td>
                </tr>
                <tr>
                  <th>Fondos custodiados</th>
                  <td>{ethers.utils.formatEther(datos.balance)} ETH</td>
                </tr>
                <tr>
                  <th>Tu saldo pendiente</th>
                  <td>{ethers.utils.formatEther(datos.saldo)} ETH</td>
                </tr>
              </tbody>
            </table>
          </section>

          <section className="tarjeta">
            <h2>Acciones</h2>
            <div className="acciones">
              {datos.estado === 0 && !esPropietario && (
                <button className="btn" disabled={ocupado || !datos.cidContrato} onClick={alquilar}>
                  Aceptar contrato y pagar{" "}
                  {ethers.utils.formatEther(datos.precio.add(datos.fianza))} ETH
                </button>
              )}
              {datos.estado === 1 && esPropietario && (
                <>
                  <button className="btn" disabled={ocupado} onClick={finalizar}>
                    Finalizar sin incidencias
                  </button>
                  <button
                    className="btn peligro"
                    disabled={ocupado || datos.evidencias === 0}
                    onClick={reclamar}
                    title="Requiere haber registrado una prueba de daños"
                  >
                    Reclamar por daños
                  </button>
                </>
              )}
              {datos.saldo.gt(0) && (
                <button className="btn" disabled={ocupado} onClick={retirar}>
                  Retirar {ethers.utils.formatEther(datos.saldo)} ETH
                </button>
              )}
            </div>
            {datos.estado === 0 && !datos.cidContrato && (
              <p className="nota">
                El propietario debe subir el contrato de alquiler antes de que
                nadie pueda alquilar.
              </p>
            )}
          </section>

          {tiposPermitidos.length > 0 && (
            <section className="tarjeta">
              <h2>Subir documento a IPFS</h2>
              <form className="form" onSubmit={subirDocumento}>
                <select
                  value={tipoSeleccionado}
                  onChange={(e) => setTipo(Number(e.target.value))}
                >
                  {tiposPermitidos.map((t) => (
                    <option key={t} value={t}>
                      {TIPOS[t]}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  placeholder="Descripción (opcional)"
                  value={descripcion}
                  onChange={(e) => setDescripcion(e.target.value)}
                />
                <input
                  type="file"
                  onChange={(e) => setFichero(e.target.files[0] || null)}
                />
                <button type="submit" className="btn" disabled={ocupado}>
                  Subir y registrar
                </button>
              </form>
            </section>
          )}

          <section className="tarjeta">
            <h2>Documentos registrados ({documentos.length})</h2>
            {documentos.length === 0 ? (
              <p className="nota">Todavía no hay documentos.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Tipo</th>
                    <th>Descripción</th>
                    <th>Autor</th>
                    <th>Fecha</th>
                    <th>CID</th>
                  </tr>
                </thead>
                <tbody>
                  {documentos.map((d) => (
                    <tr key={d.id}>
                      <td>{d.id}</td>
                      <td>{TIPOS[d.tipo]}</td>
                      <td>{d.descripcion || "—"}</td>
                      <td title={d.autor}>
                        {acortar(d.autor)}
                        {mismaDireccion(d.autor, datos.propietario) ? " (propietario)" : " (inquilino)"}
                      </td>
                      <td>{d.fecha}</td>
                      <td>
                        <a href={IPFS_GATEWAY + d.cid} target="_blank" rel="noreferrer">
                          {acortar(d.cid)}
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}

export default App;
