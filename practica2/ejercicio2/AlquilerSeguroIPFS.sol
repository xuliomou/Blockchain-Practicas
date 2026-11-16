// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title AlquilerSeguroIPFS
 * @dev Evolucion de AlquilerSeguro (Practica 1). Ademas de custodiar el alquiler y la
 *      fianza, registra en la blockchain los CID de los documentos del alquiler que se
 *      almacenan en IPFS: el contrato firmado, los inventarios y las pruebas de danos.
 *      Los ficheros viven en IPFS; on-chain solo queda su CID, su autor y su fecha.
 */
contract AlquilerSeguroIPFS {
    address payable public immutable propietario;
    uint256 public immutable precioAlquiler; // en wei
    uint256 public immutable fianza;         // en wei

    address payable public inquilino;

    enum Estado { Disponible, Alquilado, Finalizado }
    Estado public estado;

    enum TipoDocumento { Contrato, InventarioEntrada, InventarioSalida, EvidenciaDanos }

    struct Documento {
        string cid;            // identificador del fichero en IPFS
        TipoDocumento tipo;
        address autor;
        uint256 fecha;         // block.timestamp del registro
        string descripcion;
    }

    Documento[] private documentos;

    // CID del contrato de arrendamiento vigente (el que acepta el inquilino al pagar)
    string public cidContrato;

    // Numero de pruebas de danos aportadas por el propietario
    uint256 public evidenciasDanos;

    // Fondos listos para retirar (patron Pull-Payment)
    mapping(address => uint256) public saldoPendiente;

    event DocumentoRegistrado(uint256 indexed id, TipoDocumento tipo, address indexed autor, string cid);
    event PropiedadAlquilada(address indexed inquilino, uint256 totalDepositado, string cidContratoAceptado);
    event AlquilerFinalizado(bool retencionPorDanos, uint256 fianzaDevuelta);
    event FondosRetirados(address indexed usuario, uint256 cantidad);

    modifier soloPropietario() {
        require(msg.sender == propietario, "Solo el propietario puede ejecutar esto");
        _;
    }

    modifier enEstado(Estado _estadoEsperado) {
        require(estado == _estadoEsperado, "Estado del contrato incompatible");
        _;
    }

    /**
     * @param _precioEnWei Coste del alquiler en wei
     * @param _fianzaEnWei Importe de la fianza en wei
     * @dev Se usan wei (y no ether enteros como en la Practica 1) para poder probarlo
     *      en Sepolia con cantidades pequenas, p. ej. 1000000000000000 = 0.001 ETH.
     */
    constructor(uint256 _precioEnWei, uint256 _fianzaEnWei) {
        require(_precioEnWei > 0, "El precio de alquiler debe ser mayor a 0");
        propietario = payable(msg.sender);
        precioAlquiler = _precioEnWei;
        fianza = _fianzaEnWei;
        estado = Estado.Disponible;
    }

    /**
     * @notice Registra el CID de un documento subido previamente a IPFS
     * @dev Reglas segun el tipo:
     *      - Contrato: solo el propietario y solo mientras el inmueble esta Disponible.
     *      - Inventarios: propietario o inquilino, durante el alquiler.
     *      - EvidenciaDanos: solo el propietario, durante el alquiler.
     */
    function registrarDocumento(
        string calldata _cid,
        TipoDocumento _tipo,
        string calldata _descripcion
    ) external {
        require(bytes(_cid).length > 0, "El CID no puede estar vacio");

        if (_tipo == TipoDocumento.Contrato) {
            require(msg.sender == propietario, "Solo el propietario sube el contrato");
            require(estado == Estado.Disponible, "El contrato solo se puede subir antes de alquilar");
            cidContrato = _cid;
        } else {
            require(estado == Estado.Alquilado, "Solo se admiten documentos durante el alquiler");
            if (_tipo == TipoDocumento.EvidenciaDanos) {
                require(msg.sender == propietario, "Solo el propietario aporta pruebas de danos");
                evidenciasDanos++;
            } else {
                require(
                    msg.sender == propietario || msg.sender == inquilino,
                    "Solo las partes del alquiler pueden subir inventarios"
                );
            }
        }

        documentos.push(Documento({
            cid: _cid,
            tipo: _tipo,
            autor: msg.sender,
            fecha: block.timestamp,
            descripcion: _descripcion
        }));

        emit DocumentoRegistrado(documentos.length - 1, _tipo, msg.sender, _cid);
    }

    /**
     * @notice El inquilino paga alquiler + fianza y acepta el contrato almacenado en IPFS
     * @param _cidContratoAceptado CID del contrato que el inquilino ha leido; debe coincidir
     *        con el vigente, de modo que el propietario no pueda cambiarlo en el ultimo momento
     */
    function alquilar(string calldata _cidContratoAceptado) external payable enEstado(Estado.Disponible) {
        require(bytes(cidContrato).length > 0, "El propietario aun no ha subido el contrato");
        require(
            keccak256(bytes(_cidContratoAceptado)) == keccak256(bytes(cidContrato)),
            "El contrato aceptado no coincide con el vigente"
        );
        require(msg.value == (precioAlquiler + fianza), "Debe enviar exactamente el alquiler mas la fianza");

        inquilino = payable(msg.sender);
        estado = Estado.Alquilado;

        emit PropiedadAlquilada(msg.sender, msg.value, _cidContratoAceptado);
    }

    /**
     * @notice Cierre sin desperfectos: el casero cobra la renta y el inquilino recupera la fianza
     */
    function finalizarSinIncidencias() external soloPropietario enEstado(Estado.Alquilado) {
        estado = Estado.Finalizado;

        saldoPendiente[propietario] += precioAlquiler;
        saldoPendiente[inquilino] += fianza;

        emit AlquilerFinalizado(false, fianza);
    }

    /**
     * @notice Cierre con retencion de fianza. Exige que el propietario haya registrado
     *         antes al menos una prueba de danos en IPFS.
     */
    function reclamarPorDanos() external soloPropietario enEstado(Estado.Alquilado) {
        require(evidenciasDanos > 0, "Debe registrar antes una prueba de danos en IPFS");

        estado = Estado.Finalizado;

        saldoPendiente[propietario] += (precioAlquiler + fianza);

        emit AlquilerFinalizado(true, 0);
    }

    /**
     * @notice Retirada segura de fondos (estado actualizado antes de la transferencia)
     */
    function retirarFondos() external {
        uint256 cantidad = saldoPendiente[msg.sender];
        require(cantidad > 0, "No dispone de fondos pendientes para retirar");

        saldoPendiente[msg.sender] = 0;

        (bool exito, ) = payable(msg.sender).call{value: cantidad}("");
        require(exito, "Fallo al transferir los fondos");

        emit FondosRetirados(msg.sender, cantidad);
    }

    function totalDocumentos() external view returns (uint256) {
        return documentos.length;
    }

    function obtenerDocumentos() external view returns (Documento[] memory) {
        return documentos;
    }

    function obtenerBalanceContrato() external view returns (uint256) {
        return address(this).balance;
    }
}
